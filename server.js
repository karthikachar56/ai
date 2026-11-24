const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const session = require('express-session');
const Conversation = require('./models/Conversation');
const User = require('./models/User');

// Load environment configuration
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware configuration
app.use(express.json());

// MongoDB Connection Setup
const MONGODB_URI = process.env.MONGODB_URI;
const isMongoConfigured = MONGODB_URI && MONGODB_URI !== 'your_mongodb_connection_string_here';

if (isMongoConfigured) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB successfully.'))
    .catch(err => {
      console.error('Error connecting to MongoDB:', err.message);
    });
} else {
  console.log('==================================================');
  console.log(' WARNING: MongoDB Connection String is not configured.');
  console.log(' Eetirp Chatbot will run in temporary local storage fallback mode.');
  console.log(' Please configure MONGODB_URI in your .env file.');
  console.log('==================================================');
}

// Session middleware setup
const MongoStore = require('connect-mongo');

// Trust proxy for secure cookies behind reverse proxies (like Vercel)
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'eetirp-secure-session-key',
  resave: false,
  saveUninitialized: false,
  store: isMongoConfigured ? MongoStore.create({ mongoUrl: MONGODB_URI }) : undefined,
  cookie: {
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL, // Set to true if using HTTPS or running on Vercel
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  }
}));

// Temporarily bypass authentication page by auto-logging in as a guest user
app.use((req, res, next) => {
  if (req.session) {
    req.session.userId = '000000000000000000000000';
    req.session.username = 'Guest';
  }
  next();
});

// Authentication Protection Middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ error: { message: "Unauthorized. Please log in." } });
}

// Serve chat dashboard directly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// Temporarily redirect login and register pages to the root dashboard
app.get('/login', (req, res) => {
  res.redirect('/');
});

app.get('/register', (req, res) => {
  res.redirect('/');
});

// Serve other files in views/ statically (CSS, JS, logo.jpg)
app.use(express.static(path.join(__dirname, 'views'), { index: false }));

// Helper: Get API Key from server env or request headers
function getApiKey(req) {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '') {
    return { key: process.env.GEMINI_API_KEY.trim(), type: 'gemini' };
  }
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '') {
    const k = process.env.OPENAI_API_KEY.trim();
    if (k.startsWith('AQ.') || k.startsWith('AIza')) {
      return { key: k, type: 'gemini' };
    }
    return { key: k, type: 'openai' };
  }
  if (process.env.OPEN_API_KEY && process.env.OPEN_API_KEY.trim() !== '') {
    const k = process.env.OPEN_API_KEY.trim();
    if (k.startsWith('AQ.') || k.startsWith('AIza')) {
      return { key: k, type: 'gemini' };
    }
    return { key: k, type: 'openai' };
  }
  const clientKey = req?.headers ? (req.headers['x-gemini-key'] || req.headers['x-openai-key']) : null;
  if (clientKey && clientKey.trim() !== '') {
    const k = clientKey.trim();
    if (k.startsWith('AQ.') || k.startsWith('AIza')) {
      return { key: k, type: 'gemini' };
    }
    return { key: k, type: 'openai' };
  }
  return null;
}

// Endpoint: Check API Key and MongoDB status
app.get('/api/status', (req, res) => {
  const apiInfo = getApiKey(req);
  const hasApiKey = !!apiInfo;
  const isMongoActive = isMongoConfigured && mongoose.connection.readyState === 1;
  res.json({ hasApiKey, provider: apiInfo ? apiInfo.type : null, isMongoActive });
});

// ==========================================
// Authentication Endpoints
// ==========================================

// Endpoint: Register User
app.post('/api/auth/register', async (req, res) => {
  if (!isMongoConfigured || mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: { message: "Database is not connected. User registration is unavailable." }
    });
  }
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: { message: "Username, email, and password are required." } });
  }

  try {
    const existingUser = await User.findOne({ $or: [{ email: email.toLowerCase() }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: { message: "Username or email is already registered." } });
    }

    const newUser = new User({ username, email, password });
    await newUser.save();

    req.session.userId = newUser._id;
    req.session.username = newUser.username;

    res.status(201).json({ message: "Registration successful.", user: { id: newUser._id, username: newUser.username } });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: { message: "Failed to register user." } });
  }
});

// Endpoint: Login User
app.post('/api/auth/login', async (req, res) => {
  if (!isMongoConfigured || mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: { message: "Database is not connected. Authentication is unavailable." }
    });
  }
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: { message: "Username/email and password are required." } });
  }

  try {
    const user = await User.findOne({
      $or: [
        { email: identifier.toLowerCase() },
        { username: identifier }
      ]
    });

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: { message: "Invalid credentials. Please try again." } });
    }

    req.session.userId = user._id;
    req.session.username = user.username;

    res.json({ message: "Login successful.", user: { id: user._id, username: user.username } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: { message: "Internal server error during login." } });
  }
});

// Endpoint: Logout User
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Logout session destruction error:", err);
      return res.status(500).json({ error: { message: "Failed to log out cleanly." } });
    }
    res.clearCookie('connect.sid');
    res.json({ message: "Logged out successfully." });
  });
});

// Endpoint: Get current user profile
app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ user: { id: req.session.userId, username: req.session.username } });
  } else {
    res.status(401).json({ error: { message: "Not authenticated." } });
  }
});

// ==========================================
// Conversation Endpoints (Protected)
// ==========================================

// Endpoint: Fetch all conversations for the logged in user
app.get('/api/conversations', requireAuth, async (req, res) => {
  if (!isMongoConfigured || mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: { message: "Database not connected. Run in Local Storage mode or configure MONGODB_URI." }
    });
  }
  try {
    const conversations = await Conversation.find({ userId: req.session.userId }).sort({ updatedAt: -1 });
    res.json(conversations);
  } catch (err) {
    console.error("Error fetching conversations:", err);
    res.status(500).json({ error: { message: "Failed to retrieve conversations from database." } });
  }
});

// Endpoint: Create or update a conversation for the logged in user
app.post('/api/conversations', requireAuth, async (req, res) => {
  if (!isMongoConfigured || mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: { message: "Database not connected. Run in Local Storage mode or configure MONGODB_URI." }
    });
  }
  const { id, title, messages } = req.body;
  if (!id) {
    return res.status(400).json({ error: { message: "Conversation ID is required." } });
  }
  try {
    const existing = await Conversation.findOne({ id });
    if (existing && existing.userId.toString() !== req.session.userId) {
      return res.status(403).json({ error: { message: "Forbidden. You do not own this conversation." } });
    }

    const conversation = await Conversation.findOneAndUpdate(
      { id },
      { id, userId: req.session.userId, title, messages, updatedAt: Date.now() },
      { new: true, upsert: true, returnDocument: 'after' }
    );
    res.json(conversation);
  } catch (err) {
    console.error("Error saving conversation:", err);
    res.status(500).json({ error: { message: "Failed to save conversation to database." } });
  }
});

// Endpoint: Delete a conversation
app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  if (!isMongoConfigured || mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: { message: "Database not connected. Run in Local Storage mode or configure MONGODB_URI." }
    });
  }
  const { id } = req.params;
  try {
    const result = await Conversation.findOneAndDelete({ id, userId: req.session.userId });
    if (!result) {
      return res.status(404).json({ error: { message: "Conversation not found or not owned by you." } });
    }
    res.json({ message: "Conversation deleted successfully." });
  } catch (err) {
    console.error("Error deleting conversation:", err);
    res.status(500).json({ error: { message: "Failed to delete conversation from database." } });
  }
});

// ==========================================
// Proxy Endpoints (Protected)
// ==========================================

// Endpoint: Proxy content generation to Gemini or OpenAI model
app.post('/api/generate-content', requireAuth, async (req, res) => {
  const apiInfo = getApiKey(req);
  if (!apiInfo) {
    return res.status(401).json({
      error: { message: "API key is missing. Please configure GEMINI_API_KEY or OPENAI_API_KEY in your .env file." }
    });
  }

  // Handle Google Gemini API
  if (apiInfo.type === 'gemini') {
    const geminiKey = apiInfo.key;
    const model = 'gemini-3.5-flash-lite';

    // Convert OpenAI message format to Gemini format
    const contents = [];
    let systemInstruction = undefined;
    for (const msg of req.body.messages || []) {
      if (msg.role === 'system') {
        systemInstruction = { parts: [{ text: msg.content }] };
      } else {
        const text = msg.content ? String(msg.content).trim() : '';
        if (!text) continue; // Skip empty messages like assistant placeholders

        const role = msg.role === 'assistant' ? 'model' : 'user';
        // Merge consecutive messages of the same role
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
          contents[contents.length - 1].parts[0].text += '\n\n' + text;
        } else {
          contents.push({
            role: role,
            parts: [{ text: text }]
          });
        }
      }
    }

    // Gemini requires the conversation history to start with a 'user' turn
    while (contents.length > 0 && contents[0].role !== 'user') {
      contents.shift();
    }

    // Gemini strictly requires the final turn to be a 'user' turn
    while (contents.length > 0 && contents[contents.length - 1].role !== 'user') {
      contents.pop();
    }

    // Safety fallback: if no valid user turn remains, provide a default
    if (contents.length === 0) {
      contents.push({
        role: 'user',
        parts: [{ text: 'Hello' }]
      });
    }

    const geminiPayload = { contents };
    if (systemInstruction) {
      geminiPayload.systemInstruction = systemInstruction;
    }

    try {
      if (req.body.stream) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${geminiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiPayload)
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          return res.status(response.status).json(errData);
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const clean = line.trim();
            if (!clean.startsWith('data: ')) continue;
            try {
              const json = JSON.parse(clean.substring(6));
              const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                const sseData = JSON.stringify({
                  choices: [{ delta: { content: text } }]
                });
                res.write(`data: ${sseData}\n\n`);
              }
            } catch (e) {}
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Non-streaming fallback
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload)
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json(data);
      }

      const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      res.json({
        choices: [{ message: { role: 'assistant', content: replyText } }]
      });
    } catch (err) {
      console.error('Error proxying generate-content with Gemini:', err);
      res.status(500).json({ error: { message: 'Internal server error connecting to Gemini API.' } });
    }
    return;
  }

  // Handle OpenAI API
  const apiKey = apiInfo.key;
  const url = 'https://api.openai.com/v1/chat/completions';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return res.status(response.status).json(data);
    }

    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error proxying generate-content:", err);
    res.status(500).json({
      error: { message: "Internal server error connecting to OpenAI API." }
    });
  }
});

// Endpoint: Proxy Text-to-Speech requests to OpenAI model
app.post('/api/generate-tts', requireAuth, async (req, res) => {
  const apiInfo = getApiKey(req);
  if (!apiInfo) {
    return res.status(401).json({
      error: { message: "API key is missing. Please configure GEMINI_API_KEY or OPENAI_API_KEY in your server's .env file." }
    });
  }

  if (apiInfo.type === 'gemini') {
    // Return 404 to let client fall back smoothly to the browser's native WebSpeech API
    return res.status(404).json({ error: { message: "Using browser native WebSpeech synthesizer for Gemini." } });
  }

  const apiKey = apiInfo.key;
  const url = 'https://api.openai.com/v1/audio/speech';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).send(errText);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length
    });
    res.send(buffer);
  } catch (err) {
    console.error("Error proxying generate-tts:", err);
    res.status(500).json({
      error: { message: "Internal server error connecting to OpenAI TTS API." }
    });
  }
});

// Fallback all other GET requests to the main dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// Boot the server if run directly (not under serverless Vercel function)
if (require.main === module) {
  app.listen(PORT, () => {
    const apiInfo = getApiKey({ headers: {} });
    console.log(`==================================================`);
    console.log(` Eetirp Voice AI Chatbot server started!`);
    console.log(` Local host: http://localhost:${PORT}`);
    console.log(` AI Provider configured: ${apiInfo ? apiInfo.type.toUpperCase() : 'NO (Using client settings key)'}`);
    console.log(`==================================================`);
  });
}

// Export the app for Vercel Serverless Function compatibility
module.exports = app;
