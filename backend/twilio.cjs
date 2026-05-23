const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const { TWILIO_SID, TWILIO_AUTH_TOKEN, VAPI_API_KEY, ASSISTANT_ID } =
  process.env;
const VoiceResponse = twilio.twiml.VoiceResponse;

app.post("/twilio/voice", (req, res) => {
  const resp = new VoiceResponse();

  resp.say("Hello! Connecting you to your AI tutor now. Please hold.", {
    voice: "alice",
  });

  resp.connect().stream({
    url: `wss://api.vapi.ai/v2/stream?assistantId=${ASSISTANT_ID}&apikey=${VAPI_API_KEY}`,
  });

  res.type("text/xml");
  res.send(resp.toString());
});

app.post("/api/call", async (req, res) => {
  const { to } = req.body;
  try {
    const client = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);
    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_PHONE,
      url: `${process.env.PUBLIC_URL}/twilio/voice`,
      method: "POST",
    });
    res.json({ success: true, callSid: call.sid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(5800, () => console.log("🚀 Server running on port 5800"));
