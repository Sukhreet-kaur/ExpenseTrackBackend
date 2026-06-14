const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Group = require('../models/Group');
const Expense = require('../models/Expense');
const User = require('../models/User');
const Activity = require('../models/Activity');

// CSV parsing dependencies
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// ==================== HELPER FUNCTIONS ====================

// Check if date is valid
function isValidDate(dateStr) {
    if (!dateStr) return false;
    if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) return true;
    if (/^[A-Za-z]{3}-\d{1,2}$/.test(dateStr)) return true;
    return false;
}

// Fix date format (Mar-14 -> 03-14-2026)
function fixDate(dateStr) {
    const months = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
        'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
        'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
    };
    
    if (dateStr && dateStr.includes('-') && dateStr.length < 8) {
        const parts = dateStr.split('-');
        if (months[parts[0]]) {
            return `${months[parts[0]]}-${parts[1]}-2026`;
        }
    }
    return null;
}

// Clean amount (remove commas, handle negatives)
function cleanAmount(amountStr) {
    if (!amountStr) return 0;
    if (typeof amountStr === 'string') {
        amountStr = amountStr.replace(/,/g, '');
    }
    return parseFloat(amountStr);
}

// ==================== ROUTES ====================

// @route   GET /api/groups/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
      .populate('members.user', 'name email phoneNumber')
      .populate('createdBy', 'name email');

    if (!group) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const isMember = group.members.some(
      m => m.user && m.user._id.toString() === req.user._id.toString() && m.isActive !== false
    );

    if (!isMember && group.createdBy._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to view this group' });
    }

    res.json(group);
  } catch (error) {
    console.error('Get group error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/groups/:id/expenses
router.get('/:id/expenses', protect, async (req, res) => {
  try {
    const expenses = await Expense.find({ group: req.params.id })
      .populate('paidBy', 'name email')
      .populate('splitBetween.user', 'name email')
      .sort({ date: -1 });

    res.json(expenses);
  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/groups/:id/expenses
router.post('/:id/expenses', protect, async (req, res) => {
  try {
    const { 
      description, amount, currency, paid_by, date, 
      split_type, notes, splits 
    } = req.body;
    
    const groupId = req.params.id;

    console.log('📥 Received expense request:', JSON.stringify(req.body, null, 2));

    // Validation
    if (!description) {
      return res.status(400).json({ message: 'Description is required' });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Valid amount is required' });
    }
    if (!paid_by) {
      return res.status(400).json({ message: 'Paid by is required' });
    }
    if (!splits || splits.length === 0) {
      return res.status(400).json({ message: 'At least one person to split with is required' });
    }

    // Currency conversion
    let finalAmount = parseFloat(amount);
    if (currency === 'USD') finalAmount = amount * 83.5;
    else if (currency === 'EUR') finalAmount = amount * 90.5;
    else if (currency === 'GBP') finalAmount = amount * 105.5;

    // Calculate split amounts
    let splitBetween = [];
    
    if (split_type === 'equal') {
      const equalAmount = finalAmount / splits.length;
      splitBetween = splits.map(split => ({
        user: split.user_id,
        amount: equalAmount,
        settled: false
      }));
    } else if (split_type === 'unequal') {
      splitBetween = splits.map(split => ({
        user: split.user_id,
        amount: parseFloat(split.amount) || 0,
        settled: false
      }));
    } else {
      const equalAmount = finalAmount / splits.length;
      splitBetween = splits.map(split => ({
        user: split.user_id,
        amount: equalAmount,
        settled: false
      }));
    }

    console.log('💰 Split between:', JSON.stringify(splitBetween, null, 2));

    // Create expense
    const expense = await Expense.create({
      description,
      amount: finalAmount,
      original_amount: amount,
      currency: currency || 'INR',
      date: date || new Date(),
      paidBy: paid_by,
      group: groupId,
      split_type: split_type || 'equal',
      splitBetween: splitBetween,
      notes: notes || '',
    });

    // Update group total expenses
    await Group.findByIdAndUpdate(groupId, {
      $inc: { totalExpenses: finalAmount },
      updatedAt: Date.now()
    });

    // Get payer name
    const payer = await User.findById(paid_by);
    const payerName = payer ? payer.name : 'Someone';

    // Create activity
    await Activity.create({
      user: req.user._id,
      action: 'paid',
      amount: finalAmount,
      description: `${payerName} paid ${currency === 'INR' ? '₹' : '$'}${amount} for ${description}`,
      group: groupId,
      createdAt: new Date(),
    });

    console.log('✅ Expense added successfully:', expense._id);

    res.status(201).json({
      success: true,
      message: 'Expense added successfully',
      expense: expense
    });
    
  } catch (error) {
    console.error('❌ Add expense error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/groups/:id/members
router.get('/:id/members', protect, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);

    if (!group) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const activeMembers = group.members
      .filter(m => m.isActive !== false)
      .map(m => ({
        _id: m.user,
        name: m.name,
        email: m.email,
        joinedAt: m.joinedAt,
        isActive: m.isActive
      }));

    res.json(activeMembers);
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/groups/:id/members
router.post('/:id/members', protect, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const userToAdd = await User.findOne({ email });

    if (!userToAdd) {
      return res.status(404).json({ message: 'User not found with this email' });
    }

    const group = await Group.findById(req.params.id);
    
    if (!group) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const existingMember = group.members.find(m => 
      m.user && m.user.toString() === userToAdd._id.toString()
    );

    if (existingMember) {
      if (existingMember.isActive === false) {
        existingMember.isActive = true;
        existingMember.leftAt = undefined;
        existingMember.joinedAt = new Date();
        await group.save();
      } else {
        return res.status(400).json({ message: 'User already in group' });
      }
    } else {
      group.members.push({
        user: userToAdd._id,
        name: userToAdd.name,
        email: userToAdd.email,
        joinedAt: new Date(),
        isActive: true,
      });
      await group.save();
    }

    await Activity.create({
      user: req.user._id,
      action: 'added',
      description: `Added ${userToAdd.name} to the group`,
      group: req.params.id,
      withUser: userToAdd.name,
      createdAt: new Date(),
    });

    res.json({ message: 'Member added successfully', member: userToAdd });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/groups/:id/members/:memberId/leave
router.put('/:id/members/:memberId/leave', protect, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    
    if (!group) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const memberIndex = group.members.findIndex(
      m => m.user && m.user.toString() === req.params.memberId
    );

    if (memberIndex === -1) {
      return res.status(404).json({ message: 'Member not found' });
    }

    group.members[memberIndex].isActive = false;
    group.members[memberIndex].leftAt = Date.now();
    
    await group.save();

    const member = group.members[memberIndex];

    await Activity.create({
      user: req.user._id,
      action: 'left',
      description: `${member.name} left the group`,
      group: req.params.id,
      createdAt: new Date(),
    });

    res.json({ message: 'Member marked as left' });
  } catch (error) {
    console.error('Mark member left error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/groups/:id/balances
router.get('/:id/balances', protect, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    const expenses = await Expense.find({ group: req.params.id });

    if (!group) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const balances = {};
    group.members.forEach(member => {
      if (member.user && member.isActive !== false) {
        balances[member.user.toString()] = 0;
      }
    });

    for (const expense of expenses) {
      const paidById = expense.paidBy.toString();
      if (balances[paidById] !== undefined) {
        balances[paidById] += expense.amount;
      }

      for (const split of expense.splitBetween) {
        if (split.user && balances[split.user.toString()] !== undefined) {
          balances[split.user.toString()] -= split.amount;
        }
      }
    }

    const balanceList = [];
    const userId = req.user._id.toString();

    for (const [otherId, amount] of Object.entries(balances)) {
      if (otherId !== userId && Math.abs(amount) > 0.01) {
        const otherMember = group.members.find(m => m.user && m.user.toString() === otherId);
        if (otherMember) {
          balanceList.push({
            from: userId,
            to: otherId,
            fromUser: req.user.name,
            toUser: otherMember.name,
            amount: amount
          });
        }
      }
    }

    res.json(balanceList);
  } catch (error) {
    console.error('Get balances error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/groups/:id/balances/drill-down
router.get('/:id/balances/drill-down', protect, async (req, res) => {
  try {
    const { from, to } = req.query;
    
    const expenses = await Expense.find({ 
      group: req.params.id,
      paidBy: from,
      'splitBetween.user': to
    }).populate('paidBy', 'name');

    const relevantExpenses = expenses.map(expense => {
      const userSplit = expense.splitBetween.find(s => s.user.toString() === to);
      return {
        _id: expense._id,
        description: expense.description,
        amount: userSplit?.amount || 0,
        date: expense.date,
      };
    });

    res.json({ expenses: relevantExpenses });
  } catch (error) {
    console.error('Drill down error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/groups/:id/settle
router.post('/:id/settle', protect, async (req, res) => {
  try {
    const { from, to, amount } = req.body;

    if (!from || !to || !amount) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const fromUser = await User.findById(from);
    const toUser = await User.findById(to);

    const settlementExpense = await Expense.create({
      description: `Settlement payment from ${fromUser.name} to ${toUser.name}`,
      amount: parseFloat(amount),
      date: new Date(),
      paidBy: from,
      group: req.params.id,
      splitBetween: [{ user: to, amount: parseFloat(amount), settled: true }],
    });

    await Group.findByIdAndUpdate(req.params.id, {
      $inc: { totalExpenses: parseFloat(amount) },
      updatedAt: Date.now()
    });

    await Activity.create({
      user: req.user._id,
      action: 'settled',
      amount: parseFloat(amount),
      description: `${fromUser.name} settled ₹${amount} with ${toUser.name}`,
      group: req.params.id,
      withUser: toUser.name,
      createdAt: new Date(),
    });

    res.json({ message: 'Settlement recorded successfully', expense: settlementExpense });
  } catch (error) {
    console.error('Settle error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== CSV IMPORT ROUTES ====================

// @route   POST /api/groups/:id/import-csv/validate
router.post('/:id/import-csv/validate', protect, upload.single('csv'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const results = [];
        const anomalies = [];
        let rowNumber = 0;

        // Create readable stream from buffer
        const bufferStream = new Readable();
        bufferStream.push(req.file.buffer);
        bufferStream.push(null);

        await new Promise((resolve, reject) => {
            bufferStream
                .pipe(csv())
                .on('data', (row) => {
                    rowNumber++;
                    const rowNum = rowNumber + 1;
                    const cleanRow = { ...row };
                    let shouldSkip = false;
                    
                    // 1. Check missing paid_by
                    if (!row.paid_by || row.paid_by.trim() === '') {
                        anomalies.push({
                            row: rowNum,
                            type: 'missing_paid_by',
                            message: 'No payer selected',
                            action: 'skip'
                        });
                        shouldSkip = true;
                    }
                    
                    // 2. Check amount
                    let amount = cleanAmount(row.amount);
                    
                    if (amount < 0) {
                        anomalies.push({
                            row: rowNum,
                            type: 'negative_amount',
                            message: `Negative amount: ${amount} - treating as refund`,
                            action: 'keep_as_refund'
                        });
                    }
                    
                    // 3. Check comma in amount
                    if (typeof row.amount === 'string' && row.amount.includes(',')) {
                        const fixedAmount = cleanAmount(row.amount);
                        cleanRow.amount = fixedAmount;
                        anomalies.push({
                            row: rowNum,
                            type: 'comma_in_amount',
                            message: `Removed comma: ${row.amount} → ${fixedAmount}`,
                            action: 'auto_fixed'
                        });
                    } else {
                        cleanRow.amount = amount;
                    }
                    
                    // 4. Check date format
                    if (!isValidDate(row.date)) {
                        const fixedDate = fixDate(row.date);
                        if (fixedDate) {
                            cleanRow.date = fixedDate;
                            anomalies.push({
                                row: rowNum,
                                type: 'invalid_date',
                                message: `Fixed date: ${row.date} → ${fixedDate}`,
                                action: 'auto_fixed'
                            });
                        } else {
                            anomalies.push({
                                row: rowNum,
                                type: 'invalid_date',
                                message: `Cannot parse date: ${row.date}`,
                                action: 'skip'
                            });
                            shouldSkip = true;
                        }
                    }
                    
                    // 5. Check missing currency
                    if (!row.currency || row.currency.trim() === '') {
                        cleanRow.currency = 'INR';
                        anomalies.push({
                            row: rowNum,
                            type: 'missing_currency',
                            message: 'Currency missing, defaulted to INR',
                            action: 'auto_fixed'
                        });
                    }
                    
                    // 6. Check split type
                    if (!row.split_type || row.split_type.trim() === '') {
                        cleanRow.split_type = 'equal';
                        anomalies.push({
                            row: rowNum,
                            type: 'invalid_split_type',
                            message: 'Split type missing, defaulted to equal',
                            action: 'auto_fixed'
                        });
                    }
                    
                    // 7. Check zero amount
                    if (Math.abs(cleanRow.amount) === 0) {
                        anomalies.push({
                            row: rowNum,
                            type: 'zero_amount',
                            message: 'Amount is zero, skipping',
                            action: 'skip'
                        });
                        shouldSkip = true;
                    }
                    
                    // 8. Clean name (capitalize first letter)
                    if (row.paid_by) {
                        cleanRow.paid_by = row.paid_by.trim().charAt(0).toUpperCase() + 
                                          row.paid_by.slice(1).toLowerCase();
                    }
                    
                    if (!shouldSkip) {
                        results.push(cleanRow);
                    }
                })
                .on('end', resolve)
                .on('error', reject);
        });
        
        // 9. Check for duplicates
        const seen = new Set();
        const uniqueResults = [];
        const duplicates = [];
        
        for (let i = 0; i < results.length; i++) {
            const row = results[i];
            const key = `${row.date}_${row.description}_${row.amount}`;
            
            if (seen.has(key)) {
                duplicates.push({
                    row: i + 2,
                    type: 'duplicate',
                    message: `Duplicate of previous entry: ${row.description}`,
                    action: 'skip'
                });
            } else {
                seen.add(key);
                uniqueResults.push(row);
            }
        }
        
        const allAnomalies = [...anomalies, ...duplicates];
        
        res.json({
            success: true,
            summary: {
                total_rows: rowNumber,
                valid_rows: uniqueResults.length,
                skipped_rows: rowNumber - uniqueResults.length,
                anomalies_count: allAnomalies.length
            },
            anomalies: allAnomalies,
            clean_data: uniqueResults.slice(0, 10)
        });
        
    } catch (error) {
        console.error('CSV validation error:', error);
        res.status(500).json({ message: error.message });
    }
});

// @route   POST /api/groups/:id/import-csv/approve
// @route   POST /api/groups/:id/import-csv/approve
router.post('/:id/import-csv/approve', protect, async (req, res) => {
    try {
        const { clean_data } = req.body;
        const groupId = req.params.id;
        
        if (!clean_data || clean_data.length === 0) {
            return res.status(400).json({ message: 'No data to import' });
        }
        
        console.log(`📥 Importing ${clean_data.length} expenses to group ${groupId}`);
        
        let imported = 0;
        let errors = [];
        
        // Get group members
        const group = await Group.findById(groupId);
        
        if (!group) {
            return res.status(404).json({ message: 'Group not found' });
        }
        
        // Create member name to ID mapping
        const memberMap = new Map();
        group.members.forEach(m => {
            if (m.name) {
                memberMap.set(m.name.toLowerCase(), m.user);
            }
        });
        
        console.log('Available members:', Array.from(memberMap.keys()));
        
        for (const expense of clean_data) {
            try {
                // Skip if required fields missing
                if (!expense.description || !expense.amount || !expense.paid_by) {
                    errors.push(`Skipping: Missing required fields in ${expense.description || 'unknown expense'}`);
                    continue;
                }
                
                // Find paid_by user
                let paidByUser = null;
                const paidByName = expense.paid_by?.trim();
                
                if (paidByName) {
                    // Try to find by name in database
                    paidByUser = await User.findOne({ 
                        name: { $regex: new RegExp(`^${paidByName}$`, 'i') } 
                    });
                    
                    // If not found, try from group members
                    if (!paidByUser && memberMap.has(paidByName.toLowerCase())) {
                        const userId = memberMap.get(paidByName.toLowerCase());
                        if (userId) {
                            paidByUser = await User.findById(userId);
                        }
                    }
                }
                
                if (!paidByUser) {
                    errors.push(`User "${expense.paid_by}" not found in system or group`);
                    continue;
                }
                
                // Parse split_with
                let splitNames = [];
                if (expense.split_with && typeof expense.split_with === 'string') {
                    splitNames = expense.split_with.split(';').map(s => s.trim()).filter(s => s);
                }
                
                const splitBetween = [];
                const amount = Math.abs(parseFloat(expense.amount));
                
                if (splitNames.length > 0) {
                    const splitAmount = amount / splitNames.length;
                    
                    for (const splitName of splitNames) {
                        let splitUser = null;
                        
                        // Try to find by name
                        splitUser = await User.findOne({ 
                            name: { $regex: new RegExp(`^${splitName}$`, 'i') } 
                        });
                        
                        // If not found, try from group members
                        if (!splitUser && memberMap.has(splitName.toLowerCase())) {
                            const userId = memberMap.get(splitName.toLowerCase());
                            if (userId) {
                                splitUser = await User.findById(userId);
                            }
                        }
                        
                        if (splitUser) {
                            splitBetween.push({
                                user: splitUser._id,
                                amount: splitAmount,
                                settled: false
                            });
                        } else {
                            console.log(`Warning: Split member "${splitName}" not found`);
                        }
                    }
                } else {
                    // If no split_with specified, default to paid_by themselves
                    splitBetween.push({
                        user: paidByUser._id,
                        amount: amount,
                        settled: false
                    });
                }
                
                // Parse date (DD-MM-YYYY to YYYY-MM-DD)
                let dateObj = new Date();
                if (expense.date) {
                    const dateStr = expense.date.toString();
                    const parts = dateStr.split('-');
                    if (parts.length === 3) {
                        // Assuming format DD-MM-YYYY
                        dateObj = new Date(parts[2], parts[1] - 1, parts[0]);
                    }
                }
                
                // Create expense
                await Expense.create({
                    description: expense.description,
                    amount: amount,
                    original_amount: expense.amount,
                    currency: expense.currency || 'INR',
                    date: dateObj,
                    paidBy: paidByUser._id,
                    group: groupId,
                    split_type: expense.split_type || 'equal',
                    splitBetween: splitBetween,
                    notes: expense.notes || '',
                    is_refund: parseFloat(expense.amount) < 0
                });
                
                imported++;
                
            } catch (err) {
                console.error(`Error importing ${expense.description}:`, err);
                errors.push(`Error importing ${expense.description}: ${err.message}`);
            }
        }
        
        // Update group
        await Group.findByIdAndUpdate(groupId, { updatedAt: Date.now() });
        
        console.log(`✅ Import complete: ${imported} imported, ${errors.length} errors`);
        
        res.json({
            success: true,
            imported: imported,
            errors: errors,
            message: `Successfully imported ${imported} out of ${clean_data.length} expenses`
        });
        
    } catch (error) {
        console.error('Import error:', error);
        res.status(500).json({ message: error.message });
    }
});
module.exports = router;