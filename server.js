const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Serve static assets from the repository root
app.use(express.static(__dirname));

// Map img/loreal-logo.png referenced in index.html to the root loreal-logo.png asset
app.get("/img/loreal-logo.png", (req, res) => {
  res.sendFile(path.join(__dirname, "loreal-logo.png"));
});

// Serve index.html on the root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
