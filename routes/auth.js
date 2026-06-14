const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const generateToken = (id) => {
  // Use a fixed string value instead of env variable to avoid parsing issues
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn:'1h', // Direct string value instead of env variable
  });
};

// @route   POST /api/auth/register
// routes/auth.js - Register route
router.post('/register', async (req, res) => {
  try {
    const { name, email, phoneNumber, password } = req.body;

    console.log('Received registration data:', { name, email, phoneNumber, password });

    // Check if all fields are present
    if (!name || !email || !phoneNumber || !password) {
      return res.status(400).json({ message: 'Please provide all required fields' });
    }

    // Check if user exists
    const userExists = await User.findOne({ $or: [{ email }, { phoneNumber }] });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists with this email or phone number' });
    }

    // Create user
    const user = await User.create({
      name,
      email,
      phoneNumber,
      password,
    });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
      message: 'User registered successfully'
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;

    // Validation
    if (!phoneNumber || !password) {
      return res.status(400).json({ message: 'Please provide phone number and password' });
    }

    // Find user
    const user = await User.findOne({ phoneNumber });
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid phone number or password' });
    }
    
    // Check password
    const isPasswordMatch = await user.matchPassword(password);
    
    if (isPasswordMatch) {
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        token: generateToken(user._id),
      });
    } else {
      res.status(401).json({ message: 'Invalid phone number or password' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Test route
router.get('/test', (req, res) => {
  res.json({ message: 'Auth route is working!' });
});

module.exports = router;