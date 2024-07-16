const express = require("express");
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.4dm99p5.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function createAdminIfNotExists(usersCollection) {
  const existingAdmin = await usersCollection.findOne({ role: 'admin' });
  if (!existingAdmin) {
    const hashedPin = await bcrypt.hash("adminPin123", 10); // Replace with your admin pin
    const adminUser = {
      name: "Admin User",
      pin: hashedPin,
      mobileNumber: "0123456789",
      email: "admin@example.com",
      role: "admin",
      status: "approved",
      balance: 0
    };
    await usersCollection.insertOne(adminUser);
    console.log('Admin user created successfully.');
  } else {
    console.log('Admin user already exists.');
  }
}

async function run() {
  try {
    // Connect the client to the server
    await client.connect();
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");

    const database = client.db("mfsAppDb");
    const usersCollection = database.collection("users");
    const transactionsCollection = database.collection("transactions");

    // Ensure admin user is created
    await createAdminIfNotExists(usersCollection);

    // Registration Endpoint
    app.post('/register', async (req, res) => {
      const { name, pin, mobileNumber, email, role } = req.body;

      // Validate inputs
      if (!name || !pin || !mobileNumber || !email || !role) {
        return res.status(400).send('All fields are required');
      }

      // Check if user already exists
      const existingUser = await usersCollection.findOne({ $or: [{ mobileNumber }, { email }] });
      if (existingUser) {
        return res.status(400).send('User already exists with provided mobile number or email');
      }

      // Hash the PIN
      const hashedPin = await bcrypt.hash(pin, 10);

      // Set initial balance based on role
      const initialBalance = role === 'agent' ? 10000 : 0;

      // Create new user
      const newUser = {
        name,
        pin: hashedPin,
        mobileNumber,
        email,
        role,
        status: 'pending',
        balance: initialBalance
      };

      await usersCollection.insertOne(newUser);
      res.status(201).send('User registered successfully');
    });

    // Login Endpoint
    app.post('/login', async (req, res) => {
      const { mobileNumber, email, pin } = req.body;

      // Find user by mobileNumber or email
      const user = await usersCollection.findOne({ $or: [{ mobileNumber }, { email }] });
      if (!user) {
        return res.status(400).send('User not found');
      }

      // Check PIN
      const isMatch = await bcrypt.compare(pin, user.pin);
      if (!isMatch) {
        return res.status(400).send('Invalid PIN');
      }

      // Check if user is active
      if (user.status !== 'approved') {
        return res.status(400).send('Account not approved');
      }

      // Generate JWT token
      const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
      res.json({ token });
    });

    // Middleware to verify JWT
    const authenticateToken = (req, res, next) => {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];
      if (!token) return res.sendStatus(401);

      jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
      });
    };

    // Get User Balance
    app.get('/balance', authenticateToken, async (req, res) => {
      const user = await usersCollection.findOne({ _id: new ObjectId(req.user.id) });
      if (!user) return res.sendStatus(404);

      res.json({ balance: user.balance });
    });

    // Send Money
    app.post('/send-money', authenticateToken, async (req, res) => {
      const { amount, recipientMobileNumber } = req.body;
      const sender = await usersCollection.findOne({ _id: new ObjectId(req.user.id) });
      const recipient = await usersCollection.findOne({ mobileNumber: recipientMobileNumber });

      if (!recipient) return res.status(404).send('Recipient not found');
      if (sender.balance < amount) return res.status(400).send('Insufficient balance');
      if (amount < 50) return res.status(400).send('Minimum transaction amount is 50 Taka');
      if (amount > 100) {
        const fee = 5;
        if (sender.balance < amount + fee) return res.status(400).send('Insufficient balance for transaction fee');
        sender.balance -= amount + fee;
      } else {
        sender.balance -= amount;
      }

      recipient.balance += amount;
      await usersCollection.updateOne({ _id: sender._id }, { $set: { balance: sender.balance } });
      await usersCollection.updateOne({ _id: recipient._id }, { $set: { balance: recipient.balance } });

      // Record the transaction
      await transactionsCollection.insertOne({
        senderId: sender._id,
        recipientId: recipient._id,
        amount,
        fee: amount > 100 ? 5 : 0,
        type: 'send',
        date: new Date()
      });

      res.send('Transaction successful');
    });

    // Cash-Out
    app.post('/cash-out', authenticateToken, async (req, res) => {
      const { amount, agentMobileNumber } = req.body;
      const user = await usersCollection.findOne({ _id: new ObjectId(req.user.id) });
      const agent = await usersCollection.findOne({ mobileNumber: agentMobileNumber });

      if (!agent || agent.role !== 'agent') return res.status(404).send('Agent not found');
      if (user.balance < amount) return res.status(400).send('Insufficient balance');
      if (amount < 50) return res.status(400).send('Minimum cash-out amount is 50 Taka');

      const fee = amount * 0.015;
      if (user.balance < amount + fee) return res.status(400).send('Insufficient balance for transaction fee');
      
      user.balance -= (amount + fee);
      agent.balance += amount;
      await usersCollection.updateOne({ _id: user._id }, { $set: { balance: user.balance } });
      await usersCollection.updateOne({ _id: agent._id }, { $set: { balance: agent.balance } });

      // Record the transaction
      await transactionsCollection.insertOne({
        senderId: user._id,
        recipientId: agent._id,
        amount,
        fee,
        type: 'cash-out',
        date: new Date()
      });

      res.send('Cash-out successful');
    });

    // Cash-In
    app.post('/cash-in', authenticateToken, async (req, res) => {
      const { amount, agentMobileNumber } = req.body;
      const user = await usersCollection.findOne({ _id: new ObjectId(req.user.id) });
      const agent = await usersCollection.findOne({ mobileNumber: agentMobileNumber });

      if (!agent || agent.role !== 'agent') return res.status(404).send('Agent not found');

      // Process the cash-in
      agent.balance -= amount;
      user.balance += amount;
      await usersCollection.updateOne({ _id: agent._id }, { $set: { balance: agent.balance } });
      await usersCollection.updateOne({ _id: user._id }, { $set: { balance: user.balance } });

      // Record the transaction
      await transactionsCollection.insertOne({
        senderId: agent._id,
        recipientId: user._id,
        amount,
        fee: 0,
        type: 'cash-in',
        date: new Date()
      });

      res.send('Cash-in successful');
    });

    // View Transactions History
    app.get('/transactions', authenticateToken, async (req, res) => {
      const userId = new ObjectId(req.user.id);
      const transactions = await transactionsCollection.find({ $or: [{ senderId: userId }, { recipientId: userId }] })
        .sort({ date: -1 })
        .limit(10)
        .toArray();

      res.json(transactions);
    });

    // Admin Endpoints
    // Admin Login
    app.post('/admin/login', async (req, res) => {
      const { mobileNumber, email, pin } = req.body;
      const admin = await usersCollection.findOne({ $or: [{ mobileNumber }, { email }], role: 'admin' });
      if (!admin) return res.status(400).send('Admin not found');

      const isMatch = await bcrypt.compare(pin, admin.pin);
      if (!isMatch) return res.status(400).send('Invalid PIN');

      const token = jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
      res.json({ token });
    });

    // Get Users List
    app.get('/admin/users', authenticateToken, async (req, res) => {
      if (req.user.role !== 'admin') return res.sendStatus(403);

      const users = await usersCollection.find({}).toArray();
      res.json(users);
    });

    // Approve or Reject User
    app.post('/admin/approve-user', authenticateToken, async (req, res) => {
      if (req.user.role !== 'admin') return res.sendStatus(403);

      const { userId, action } = req.body;
      if (!userId || !action || !['approve', 'reject'].includes(action)) {
        return res.status(400).send('Invalid request');
      }

      const status = action === 'approve' ? 'approved' : 'rejected';
      await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { status } });
      res.send(`User ${status} successfully`);
    });

  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
