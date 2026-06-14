const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Group = require('../models/Group');
const Expense = require('../models/Expense');
const Activity = require('../models/Activity');

// @route   GET /api/dashboard/stats
router.get('/stats', protect, async (req, res) => {
  try {
    const userId = req.user._id;

    // Get user's groups
    const groups = await Group.find({
      'members.user': userId,
      'members.isActive': true,
    });

    // Get all expenses where user is involved
    const expenses = await Expense.find({
      group: { $in: groups.map(g => g._id) },
    });

    let totalExpenses = 0;
    let youOwe = 0;
    let youAreOwed = 0;

    for (const expense of expenses) {
      totalExpenses += expense.amount;
      
      const userSplit = expense.splitBetween.find(
        split => split.user && split.user.toString() === userId.toString()
      );
      
      if (userSplit) {
        if (expense.paidBy.toString() === userId.toString()) {
          youAreOwed += expense.amount - userSplit.amount;
        } else {
          youOwe += userSplit.amount;
        }
      }
    }

    // Always return all fields with proper defaults
    res.json({
      totalGroups: groups.length || 0,
      totalExpenses: totalExpenses || 0,
      youOwe: youOwe || 0,
      youAreOwed: youAreOwed || 0,
    });
  } catch (error) {
    console.error('Stats error:', error);
    // Return default values on error
    res.status(500).json({ 
      totalGroups: 0,
      totalExpenses: 0,
      youOwe: 0,
      youAreOwed: 0,
      message: error.message 
    });
  }
});

// @route   GET /api/dashboard/groups
router.get('/groups', protect, async (req, res) => {
  try {
    const userId = req.user._id;

    const groups = await Group.find({
      'members.user': userId,
      'members.isActive': true,
    });

    // Calculate balances for each group
    const groupsWithBalance = await Promise.all(
      groups.map(async (group) => {
        const expenses = await Expense.find({ group: group._id });
        
        let balance = 0;
        for (const expense of expenses) {
          const userSplit = expense.splitBetween.find(
            split => split.user && split.user.toString() === userId.toString()
          );
          
          if (userSplit) {
            if (expense.paidBy.toString() === userId.toString()) {
              balance += expense.amount - userSplit.amount;
            } else {
              balance -= userSplit.amount;
            }
          }
        }

        return {
          _id: group._id,
          name: group.name,
          icon: group.icon || '👥',
          balance: balance || 0,
          members: group.members.filter(m => m.isActive !== false).length || 0,
          lastUpdated: group.updatedAt || group.createdAt || new Date(),
        };
      })
    );

    res.json(groupsWithBalance || []);
  } catch (error) {
    console.error('Groups error:', error);
    res.status(500).json({ message: error.message, data: [] });
  }
});

// @route   GET /api/dashboard/activities
router.get('/activities', protect, async (req, res) => {
  try {
    const activities = await Activity.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('group', 'name');

    res.json(activities || []);
  } catch (error) {
    console.error('Activities error:', error);
    res.status(500).json({ message: error.message, data: [] });
  }
});

// @route   POST /api/dashboard/create-group
router.post('/create-group', protect, async (req, res) => {
  try {
    const { name, icon } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Group name is required' });
    }

    const group = await Group.create({
      name,
      icon: icon || '👥',
      members: [{
        user: req.user._id,
        name: req.user.name,
        email: req.user.email,
        joinedAt: new Date(),
        isActive: true,
      }],
      createdBy: req.user._id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create activity
    await Activity.create({
      user: req.user._id,
      action: 'created',
      description: `Created group "${name}"`,
      group: group._id,
      createdAt: new Date(),
    });

    res.status(201).json(group);
  } catch (error) {
    console.error('Create group error:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;