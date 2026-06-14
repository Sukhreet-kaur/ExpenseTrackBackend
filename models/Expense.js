// models/Expense.js
const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
  description: {
    type: String,
    required: [true, 'Please add description'],
  },
  amount: {
    type: Number,
    required: [true, 'Please add amount'],
  },
  original_amount: {
    type: Number,
  },
  currency: {
    type: String,
    default: 'INR',
    enum: ['INR', 'USD', 'EUR', 'GBP'],
  },
  date: {
    type: Date,
    default: Date.now,
  },
  paidBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    required: true,
  },
  split_type: {
    type: String,
    enum: ['equal', 'unequal', 'percentage', 'share'],
    default: 'equal',
  },
  splitBetween: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    amount: {
      type: Number,
    },
    percentage: {
      type: Number,
    },
    shares: {
      type: Number,
    },
    settled: {
      type: Boolean,
      default: false,
    },
  }],
  split_details: {
    type: String,
  },
  notes: {
    type: String,
  },
  is_refund: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Expense', expenseSchema);