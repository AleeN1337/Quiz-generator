require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const Quiz = require("./models/Quiz");
const stringSimilarity = require("string-similarity");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// MongoDB
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log(" MongoDB connected"))
  .catch((err) => console.error(" MongoDB error:", err));

// Generowanie quizu
app.post("/generate-quiz", async (req, res) => {
  const { sourceText, quizType = "open-ended" } = req.body;
  let prompt;
  if (quizType === "multiple-choice") {
    prompt = `Na podstawie poniższego tekstu stwórz dokładnie 5 pytań quizowych wielokrotnego wyboru.
Do każdego pytania podaj dokładnie 4 opcje odpowiedzi w formacie:
"A. ...", "B. ...", "C. ...", "D. ..."

Zaznacz poprawną odpowiedź w polu "correctAnswer", podając tylko literę: A, B, C lub D.

Zwróć wynik jako czysty JSON:
[
  {
    "question": "...",
    "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
    "correctAnswer": "C"
  }
]

Tekst:
${sourceText}`;
  } else {
    prompt = `Na podstawie poniższego tekstu stwórz dokładnie 5 pytań quizowych z odpowiedziami.

Zwróć dane w czystym formacie JSON. Każdy element musi zawierać:
- "question": treść pytania,
- "answer": poprawną odpowiedź.

[
  { "question": "...", "answer": "..." }
]

Tekst:
${sourceText}`;
  }

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "mistralai/mistral-7b-instruct",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "Quiz Generator",
        },
      }
    );

    const content = response.data.choices[0].message.content;
    console.log("Odpowiedź LLM:\n", content);

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return res.status(500).json({
        error: "Nieprawidłowy JSON",
        raw: content,
      });
    }

    const newQuiz = new Quiz({ sourceText, questions: parsed, quizType });
    await newQuiz.save();

    res.json({ message: "Quiz wygenerowany", quiz: newQuiz });
  } catch (error) {
    console.error(
      " Błąd generowania quizu:",
      error?.response?.data || error.message
    );
    res.status(500).json({ error: "Błąd po stronie serwera" });
  }
});

// Pobieranie
async function createDocx(questions) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-docx-"));
  fs.mkdirSync(path.join(tmpDir, "_rels"));
  fs.mkdirSync(path.join(tmpDir, "word"));

  const docContent = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "  <w:body>",
  ];
  questions.forEach((q, i) => {
    docContent.push(
      `    <w:p><w:r><w:t>Pytanie ${i + 1}: ${q.question}</w:t></w:r></w:p>`
    );
    if (q.options) {
      q.options.forEach((opt) => {
        docContent.push(`    <w:p><w:r><w:t>- ${opt}</w:t></w:r></w:p>`);
      });
    }
    const ans = q.correctAnswer || q.answer || "brak odpowiedzi";
    docContent.push(
      `    <w:p><w:r><w:t>Odpowiedz\u017a: ${ans}</w:t></w:r></w:p>`
    );
  });
  docContent.push("  </w:body>", "</w:document>");
  fs.writeFileSync(
    path.join(tmpDir, "word", "document.xml"),
    docContent.join("\n")
  );

  const out = path.join(os.tmpdir(), `quiz-${Date.now()}.docx`);
  await new Promise((resolve, reject) => {
    exec(`cd ${tmpDir} && zip -r ${out} .`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const buffer = fs.readFileSync(out);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.unlinkSync(out);
  return buffer;
}
app.get("/download/:id", async (req, res) => {
  const { id } = req.params;
  const format = req.query.format;

  try {
    const quiz = await Quiz.findById(id);
    if (!quiz) return res.status(404).json({ error: "Quiz nie znaleziony" });

    const parsed = quiz.questions;

    if (format === "pdf") {
      const PDFDocument = require("pdfkit");
      const doc = new PDFDocument();
      doc.registerFont(
        "Polish",
        path.join(__dirname, "fonts", "DejaVuSans.ttf")
      );
      doc.font("Polish");

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=quiz.pdf");
      doc.pipe(res);

      doc.fontSize(18).text("Quiz", { align: "center" }).moveDown();

      parsed.forEach((q, i) => {
        doc
          .fontSize(14)
          .text(`Pytanie ${i + 1}: ${q.question}`)
          .moveDown(0.5);
        if (q.options) q.options.forEach((opt) => doc.text(`- ${opt}`));
        const answer = q.correctAnswer || q.answer || "brak odpowiedzi";
        doc.text(`Odpowiedź: ${answer}`).moveDown(1);
      });

      doc.end();
      return;
    }

    if (format === "csv") {
      const { Parser } = require("json2csv");
      const parser = new Parser({
        fields: ["question", "options", "correctAnswer"],
      });
      const csv = parser.parse(
        parsed.map((q) => ({
          question: q.question,
          options: q.options?.join(" | ") || "",
          correctAnswer: q.correctAnswer || q.answer || "",
        }))
      );
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=quiz.csv");
      return res.send(csv);
    }
    if (format === "docx") {
      try {
        const buffer = await createDocx(parsed);
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        res.setHeader("Content-Disposition", "attachment; filename=quiz.docx");
        return res.end(buffer);
      } catch (e) {
        console.error("Błąd generowania DOCX:", e.message);
        return res.status(500).json({ error: "Błąd generowania DOCX" });
      }
    }

    if (format === "png") {
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0pU1EAAAAASUVORK5CYII=";
      const buffer = Buffer.from(pngBase64, "base64");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", "attachment; filename=quiz.png");
      return res.end(buffer);
    }

    res.status(400).json({ error: "Nieobsługiwany format" });
  } catch (err) {
    console.error("Błąd pobierania quizu:", err.message);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// Pobieranie quizów
app.get("/quizzes", async (req, res) => {
  try {
    const quizzes = await Quiz.find().sort({ createdAt: -1 });
    res.json(quizzes);
  } catch (error) {
    res.status(500).json({ error: "Błąd pobierania quizów" });
  }
});

app.listen(port, () => {
  console.log(`Serwer działa na porcie ${port}`);
});
