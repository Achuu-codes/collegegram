const express = require("express");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("API Running");
});

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("DB Connected"))
.catch(err => console.log(err));

app.listen(5000, () => {
  console.log("Server running on port 5000");
});