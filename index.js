require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const Quiz = require("./models/Quiz");
const stringSimilarity = require("string-similarity");

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
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// LLM
async function detectFormatWithLLM(sourceText) {
  const prompt = `
Użytkownik napisał:

${sourceText}

Zinterpretuj, w jakim formacie chce otrzymać wynik quizu. Rozpoznaj także literówki, synonimy i skróty.

Dopuszczalne odpowiedzi: pdf, csv, json, markdown, docx, html.

Odpowiedz tylko jednym z tych słów. Jeśli nie wiadomo – odpowiedz "none".
`.trim();

  const allowedFormats = ["pdf", "csv", "json", "markdown", "docx", "html"];

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

    const raw = response.data.choices[0].message.content.trim().toLowerCase();
    console.log("Raw odpowiedź modelu:", raw);

    const match = stringSimilarity.findBestMatch(raw, allowedFormats);
    if (match.bestMatch.rating > 0.5) {
      console.log("✅ Rozpoznany format:", match.bestMatch.target);
      return match.bestMatch.target;
    }

    return "none";
  } catch (err) {
    console.error("Błąd LLM:", err?.message);
    return "none";
  }
}

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

    const format = await detectFormatWithLLM(sourceText);

    // PDF
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

    // CSV
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

    // Domyślnie JSON
    res.json({ message: "Quiz wygenerowany", quiz: newQuiz });
  } catch (error) {
    console.error(
      " Błąd generowania quizu:",
      error?.response?.data || error.message
    );
    res.status(500).json({ error: "Błąd po stronie serwera" });
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
