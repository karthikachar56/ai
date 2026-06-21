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
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '') {
    return process.env.OPENAI_API_KEY;
  }
  if (process.env.OPEN_API_KEY && process.env.OPEN_API_KEY.trim() !== '') {
    return process.env.OPEN_API_KEY;
  }
  const clientKey = req.headers['x-openai-key'] || req.headers['x-gemini-key'];
  if (clientKey && clientKey.trim() !== '') {
    return clientKey;
  }
  return null;
}

// Endpoint: Check API Key and MongoDB status
app.get('/api/status', (req, res) => {
  const hasApiKey = !!((process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '') ||
                       (process.env.OPEN_API_KEY && process.env.OPEN_API_KEY.trim() !== ''));
  const isMongoActive = isMongoConfigured && mongoose.connection.readyState === 1;
  res.json({ hasApiKey, isMongoActive });
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

// Endpoint: Proxy content generation to OpenAI model
app.post('/api/generate-content', requireAuth, async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({
      error: { message: "OpenAI API key is missing. Please configure it in your server's .env file or input it in Settings." }
    });
  }

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
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({
      error: { message: "OpenAI API key is missing. Please configure it in your server's .env file or input it in Settings." }
    });
  }

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
    const hasKey = !!((process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '') || 
                      (process.env.OPEN_API_KEY && process.env.OPEN_API_KEY.trim() !== ''));
    console.log(`==================================================`);
    console.log(` Eetirp Voice AI Chatbot server started!`);
    console.log(` Local host: http://localhost:${PORT}`);
    console.log(` Server-side OpenAI key configured: ${hasKey ? 'YES' : 'NO (Using client settings key)'}`);
    console.log(`==================================================`);
  });
}

// Export the app for Vercel Serverless Function compatibility
module.exports = app;
