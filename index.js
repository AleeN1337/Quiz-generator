require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const Quiz = require("./models/Quiz");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error(" MongoDB error:", err));

// generowanie quizu przez DeepSeek
app.post("/generate-quiz", async (req, res) => {
  const { sourceText, quizType = "open-ended" } = req.body;

  let prompt;
  if (quizType === "multiple-choice") {
    prompt = `Na podstawie poniższego tekstu stwórz dokładnie 5 pytań quizowych wielokrotnego wyboru.
Do każdego pytania podaj dokładnie 4 opcje odpowiedzi w formacie:

"A. ...", "B. ...", "C. ...", "D. ..."

Zaznacz poprawną odpowiedź w polu "correctAnswer", podając tylko literę: A, B, C lub D.

Zwróć wynik jako czysty JSON w tym formacie:
[
  {
    "question": "Pytanie...",
    "options": ["A. opcja1", "B. opcja2", "C. opcja3", "D. opcja4"],
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

Przykład:
[
  { "question": "Pytanie...", "answer": "Odpowiedź..." }
]

Nie dodawaj nic poza JSON-em.

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
    //console.log("Odpowiedź od modelu:\n", content);

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return res.status(500).json({
        error: "Nieprawidłowy JSON z DeepSeek",
        raw: content,
      });
    }

    const newQuiz = new Quiz({ sourceText, questions: parsed, quizType });
    await newQuiz.save();

    res.json({ message: "Quiz wygenerowany przez DeepSeek", quiz: newQuiz });
  } catch (error) {
    console.error("Błąd:", error?.response?.data || error.message);
    res
      .status(500)
      .json({ error: "Nie udało się połączyć z modelem DeepSeek" });
  }
});

//pobieranie quizów

app.get("/quizzes", async (req, res) => {
  try {
    const quizzes = await Quiz.find().sort({ createdAt: -1 });
    res.json(quizzes);
  } catch (error) {
    res.status(500).json({ error: "Błąd podczas pobierania quizów" });
  }
});

//Start serwera
app.listen(port, () => {
  console.log(` Serwer działa na porcie ${port}`);
});
