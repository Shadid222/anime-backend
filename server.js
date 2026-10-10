const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection



console.log('MongoDB URI has legacy options:',
  /useNewUrlParser|useUnifiedTopology/i.test(process.env.MONGO_URI || '')
);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✓ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));


// ========== SCHEMAS ==========

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  isPremium: { type: Boolean, default: false },
  premiumUntil: { type: Date },
  watchHistory: [{ animeId: String, episode: Number, timestamp: Date }],
  createdAt: { type: Date, default: Date.now }
});

const animeSchema = new mongoose.Schema({
  title: String,
  description: String,
  genre: [String],
  rating: Number,
  posterUrl: String,
  category: String,
  language: [String],
  episodes: [{
    number: Number,
    title: String,
    videoUrl: String,
    views: { type: Number, default: 0 }
  }],
  trending: Boolean,
  featured: Boolean,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Anime = mongoose.model('Anime', animeSchema);

// ========== MIDDLEWARE ==========

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========== AUTH ==========

app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashed });
    await user.save();
    
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email, isPremium: false } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Email not found' });
    }
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Wrong password' });
    }
    
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email, isPremium: user.isPremium } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ========== ANIME ENDPOINTS ==========

app.get('/api/anime', async (req, res) => {
  try {
    const anime = await Anime.find().sort({ createdAt: -1 });
    res.json(anime);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch anime' });
  }
});

app.get('/api/anime/trending', async (req, res) => {
  try {
    const trending = await Anime.find({ trending: true }).limit(20);
    res.json(trending);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trending' });
  }
});

app.get('/api/anime/category/:category', async (req, res) => {
  try {
    const anime = await Anime.find({ category: req.params.category });
    res.json(anime);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch category' });
  }
});

app.get('/api/anime/:id', async (req, res) => {
  try {
    const anime = await Anime.findById(req.params.id);
    if (!anime) return res.status(404).json({ error: 'Not found' });
    res.json(anime);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch anime' });
  }
});

app.get('/api/search/:query', async (req, res) => {
  try {
    const anime = await Anime.find({
      $or: [
        { title: { $regex: req.params.query, $options: 'i' } },
        { description: { $regex: req.params.query, $options: 'i' } }
      ]
    });
    res.json(anime);
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// ========== WATCH HISTORY ==========

app.post('/api/watch-history', verifyToken, async (req, res) => {
  try {
    const { animeId, episode } = req.body;
    const user = await User.findById(req.userId);
    user.watchHistory.push({ animeId, episode, timestamp: new Date() });
    await user.save();
    
    await Anime.updateOne(
      { _id: animeId, 'episodes.number': episode },
      { $inc: { 'episodes.$.views': 1 } }
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save watch history' });
  }
});

// ========== STRIPE ==========

const stripe = require('stripe')(process.env.STRIPE_SECRET);

app.post('/api/create-checkout', verifyToken, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Premium Subscription' },
          unit_amount: 399,
          recurring: { interval: 'month', interval_count: 1 }
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/success`,
      cancel_url: `${process.env.FRONTEND_URL}/`,
      customer_email: req.body.email,
      metadata: { userId: req.userId }
    });
    
    res.json({ sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// ========== ADMIN: ADD ANIME ==========

app.post('/api/anime/add', async (req, res) => {
  try {
    const anime = new Anime(req.body);
    await anime.save();
    res.json({ success: true, anime });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add anime' });
  }
});

// ========== START SERVER ==========

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Anime Backend is online!'
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✓ Server running on http://localhost:${PORT}`);
});
