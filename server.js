const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const translate = require('google-translate-api-x');
const { JSDOM } = require("jsdom"); 
const textToSpeech = require('@google-cloud/text-to-speech');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static TTS files

const STELLARIUM_API_URL = "http://localhost:8090/api/objects/info?format=json";
const WIKI_API_URL_EN = "https://en.wikipedia.org/w/api.php?action=query&redirects&prop=extracts&explaintext&format=json&origin=*&titles=";

mongoose.connect('mongodb+srv://sre:sreya123@devapi.cvmpfgn.mongodb.net/starBuddy', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

const celestialSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  type: String,
  iauConstellation: String,
  azimuthAngle: Number,
  altitudeAngle: Number,
  description: String,
  translations: {
    malayalam: String,
    hindi: String,
    tamil: String,
    kannada: String,
    telugu: String,
  },
  tts_url: String,
});

const sessionLogSchema = new mongoose.Schema({
  name: String,
  type: String,
  date: { type: Date, default: Date.now },
  time: String,
});

// Student Query Schema (UPDATED)
const studentQuerySchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,       // <-- Added 'phone' field
  query: String,       // <-- Renamed 'message' to 'query'
  date: { type: Date, default: Date.now },
});



const CelestialObject = mongoose.model('CelestialObject', celestialSchema);
const SessionLog = mongoose.model('SessionLog', sessionLogSchema);
const StudentQuery = mongoose.model('StudentQuery', studentQuerySchema);

async function fetchWikipediaDescription(name) {
  try {
    if (!name) return "No additional details available.";

    const nameMappings = {
      "Mercury": "Mercury_(planet)",
      "Pollux": "Pollux_(star)",
      
    };
   
    let formattedName = nameMappings[name] || name; 

    const response = await axios.get(WIKI_API_URL_EN + encodeURIComponent(formattedName));
    const pages = response.data.query?.pages;
    const pageId = Object.keys(pages)[0];

    if (pageId === "-1") return "No additional details available.";

    let description = pages[pageId]?.extract || "No additional details available.";

    const dom = new JSDOM(description);
    const cleanText = dom.window.document.body.textContent || "";

    let sentences = cleanText.split(/(?<=[.!?])\s+/).slice(0, 4).join(" ");

    return sentences || "No additional details available.";
  } catch (error) {
    console.error("Error fetching Wikipedia description:", error);
    return "No additional details available.";
  }
}

async function generateTTSFile(name, fullText) {
  if (!name || !fullText || fullText === "No additional details available.") return "";

  const filePath = `/tts/tts_${name}_en.mp3`;
  const fullPath = path.join(__dirname, 'public', filePath);

  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, fullText, 'utf-8'); 
  }

  return filePath;
}

app.post('/api/queries', async (req, res) => {
  try {
    const { name, email, phone, query } = req.body;

    const newQuery = new StudentQuery({ name, email, phone, query });
    await newQuery.save();

    res.status(201).json({ message: "Query submitted successfully!" });
  } catch (error) {
    console.error("Error saving student query:", error);
    res.status(500).json({ error: "Failed to submit query." });
  }
});


app.post('/save-object', async (req, res) => {
  try {
    const stellariumData = req.body;

    if (!stellariumData || !stellariumData["localized-name"]) {
      return res.status(400).json({ error: "Invalid data received from frontend" });
    }

    const {
      "localized-name": name,
      "object-type": type,
      "iauConstellation": iauConstellation,
      "azimuth": azimuthAngle,
      "altitude": altitudeAngle
    } = stellariumData;

    let celestialObject = await CelestialObject.findOne({ name });

    if (!celestialObject) {
      console.log(`New object detected: ${name}, fetching Wikipedia data...`);
      const description = await fetchWikipediaDescription(name);

      let fullText = `Name: ${name}. Type: ${type}. Constellation: ${iauConstellation}. Azimuth Angle: ${azimuthAngle} degrees. Altitude Angle: ${altitudeAngle} degrees. Description: ${description}`;

      const translations = await Promise.all([
        translate(description, { to: "ml" }).then(res => res.text),
        translate(description, { to: "hi" }).then(res => res.text),
        translate(description, { to: "ta" }).then(res => res.text),
        translate(description, { to: "kn" }).then(res => res.text),
        translate(description, { to: "te" }).then(res => res.text)
      ]);
      const [desc_ml, desc_hi, desc_ta, desc_kn, desc_te] = translations;

      const tts_url = await generateTTSFile(name, fullText);

      celestialObject = new CelestialObject({
        name,
        type,
        iauConstellation,
        azimuthAngle,
        altitudeAngle,
        description,
        translations: {
          malayalam: desc_ml,
          hindi: desc_hi,
          tamil: desc_ta,
          kannada: desc_kn,
          telugu: desc_te,
        },
        tts_url,
      });

      await celestialObject.save();
      console.log(`Saved new celestial object: ${name}`);
    } else {
      let fullText = `Name: ${celestialObject.name}. Type: ${celestialObject.type}. Constellation: ${celestialObject.iauConstellation}. Azimuth Angle: ${celestialObject.azimuthAngle} degrees. Altitude Angle: ${celestialObject.altitudeAngle} degrees. Description: ${celestialObject.description}`;

      if (!celestialObject.tts_url) {
        celestialObject.tts_url = await generateTTSFile(celestialObject.name, fullText);
        await celestialObject.save();
      }
    }

    const sessionLog = new SessionLog({
      name: celestialObject.name,
      type: celestialObject.type,
      time: new Date().toLocaleTimeString(),
    });

    await sessionLog.save();
    console.log(`Session logged for: ${name}`);

    return res.status(200).json({
      name: celestialObject.name,
      type: celestialObject.type,
      iauConstellation: celestialObject.iauConstellation,
      azimuthAngle: celestialObject.azimuthAngle,
      altitudeAngle: celestialObject.altitudeAngle,
      description: celestialObject.description,
      translations: celestialObject.translations,
      tts_url: celestialObject.tts_url,
    });

  } catch (error) {
    console.error("Error processing object:", error);
    return res.status(500).json({ error: "Server error while processing celestial object." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
