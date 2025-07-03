const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema({
  question: String,
  answer: String,
  options: [String],
  correctAnswer: String,
});

const quizSchema = new mongoose.Schema({
  sourceText: String,
  quizType: { type: String, default: "open-ended" },
  questions: [questionSchema],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Quiz", quizSchema);
