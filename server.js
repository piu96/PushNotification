
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/notifications', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Import MongoDB schemas
const { Device, DeviceNotificationState, Notification, User, PushQueue, SyncLog } = require('./models');

// In-memory locks for atomic operations (in production, use Redis)
const operationLocks = new Map();

// Atomic operation helper
async function executeAtomicOperation(notificationId, operation) {
  // Wait for any existing operation to complete
  if (operationLocks.has(notificationId)) {
    await operationLocks.get(notificationId);
  }
  
  // Execute operation with lock
  const operationPromise = operation();
  operationLocks.set(notificationId, operationPromise);
  
  try {
    return await operationPromise;
  } finally {
    operationLocks.delete(notificationId);
  }
}

// Routes

// Create a new notification
app.post('/notifications', async (req, res) => {
  try {
    const { userId, content, title, type = 'message', priority = 'normal' } = req.body;
    const notificationId = uuidv4();
    
    // Get all user devices
    const devices = await Device.find({ userId, isActive: true });
    
    // Create lean notification (no deviceStates array)
    const notification = new Notification({
      notificationId,
      userId,
      content,
      title,
      type,
      priority
    });
    await notification.save();
    
    // Create separate DeviceNotificationState documents for each device
    const deviceStateDocs = devices.map(device => ({
      notificationId,
      deviceId: device.deviceId,
      userId,
      isRead: false,
      readAt: null,
      lastSyncAt: new Date(),
      version: 1
    }));
    if (deviceStateDocs.length > 0) {
      await DeviceNotificationState.insertMany(deviceStateDocs);
    }
    
    // Queue push notifications for online devices
    const onlineDevices = devices.filter(d => d.isOnline && d.pushToken);
    
    if (onlineDevices.length > 0) {
      const pushQueue = new PushQueue({
        queueId: uuidv4(),
        notificationId,
        userId,
        deviceIds: onlineDevices.map(d => d.deviceId),
        content: {
          title: title || 'New Notification',
          body: content,
          data: { notificationId, type, priority }
        }
      });
      
      await pushQueue.save();
    }
    
    res.status(201).json({
      success: true,
      notificationId,
      queuedFor: onlineDevices.map(d => d.deviceId),
      totalDevices: devices.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Register/update user
app.post('/users', async (req, res) => {
  try {
    const { userId, username, email, notificationSettings } = req.body;
    
    const user = await User.findOneAndUpdate(
      { userId },
      {
        username,
        email,
        notificationSettings: notificationSettings || {},
        isActive: true
      },
      { upsert: true, new: true }
    );
    
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mark notification as read - OPTIMIZED with separate DeviceNotificationState collection
app.post('/notifications/:notificationId/read', async (req, res) => {
  try {
    const { notificationId } = req.params;
    const { deviceId, userId, timestamp = new Date() } = req.body;
    
    const result = await executeAtomicOperation(notificationId, async () => {
      // Step 1: Atomically update device-specific state
      const deviceState = await DeviceNotificationState.markAsReadAtomic(
        notificationId, 
        deviceId, 
        userId, 
        timestamp
      );
      
      if (!deviceState) {
        return { success: false, reason: 'failed_to_update_device_state' };
      }
      
      // Step 2: Check if this is the first read globally and update notification
      const notification = await Notification.findOneAndUpdate(
        { 
          notificationId,
          isGloballyRead: false  // Only update if not globally read yet
        },
        {
          $set: {
            isGloballyRead: true,
            globalReadAt: timestamp,
            globalReadByDevice: deviceId
          },
          $inc: { version: 1 }
        },
        {
          new: true,
          runValidators: true
        }
      );
      
      // If notification is null, it was already marked as globally read
      // but that's OK - device state was still updated atomically
      
      return { 
        success: true, 
        deviceState,
        wasFirstGlobalRead: !!notification,
        globalReadAt: timestamp
      };
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get notifications for a user/device - OPTIMIZED with separate DeviceNotificationState
app.get('/notifications/:userId/:deviceId', async (req, res) => {
  try {
    const { userId, deviceId } = req.params;
    
    // Get notifications for user
    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50);
    
    // Get device-specific states for these notifications
    const notificationIds = notifications.map(n => n.notificationId);
    const deviceStates = await DeviceNotificationState.find({
      notificationId: { $in: notificationIds },
      deviceId
    });
    
    // Create lookup map for device states
    const deviceStateMap = new Map();
    deviceStates.forEach(ds => {
      deviceStateMap.set(ds.notificationId, ds);
    });
    
    res.json({
      success: true,
      notifications: notifications.map(n => ({
        notificationId: n.notificationId,
        content: n.content,
        title: n.title,
        type: n.type,
        priority: n.priority,
        isGloballyRead: n.isGloballyRead,
        globalReadAt: n.globalReadAt,
        globalReadByDevice: n.globalReadByDevice,
        deviceState: deviceStateMap.get(n.notificationId) || {
          isRead: false,
          readAt: null,
          lastSyncAt: null
        },
        createdAt: n.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Register/update device
app.post('/devices', async (req, res) => {
  try {
    const { deviceId, userId, deviceName, pushToken } = req.body;
    
    const device = await Device.findOneAndUpdate(
      { deviceId },
      {
        userId,
        deviceName,
        pushToken,
        isOnline: true,
        lastSeen: new Date()
      },
      { upsert: true, new: true }
    );
    
    res.json({ success: true, device });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get unread count for a user/device - OPTIMIZED with separate collection
app.get('/notifications/:userId/:deviceId/unread-count', async (req, res) => {
  try {
    const { userId, deviceId } = req.params;
    
    const unreadCount = await DeviceNotificationState.getUserUnreadCount(userId);
    
    res.json({
      success: true,
      unreadCount,
      userId,
      deviceId
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Device sync - for offline devices coming back online
app.post('/sync/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { lastSyncAt } = req.body;
    
    const device = await Device.findOne({ deviceId });
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }
    
    // Get notifications updated since last sync
    const notifications = await Notification.find({
      userId: device.userId,
      updatedAt: { $gt: new Date(lastSyncAt) }
    }).sort({ updatedAt: -1 });
    
    // Update device's last seen
    await Device.updateOne(
      { deviceId },
      { lastSeen: new Date(), isOnline: true }
    );
    
    res.json({
      success: true,
      notifications: notifications.map(n => ({
        notificationId: n.notificationId,
        content: n.content,
        isGloballyRead: n.isGloballyRead,
        globalReadAt: n.globalReadAt,
        version: n.version,
        deviceState: n.deviceStates.find(ds => ds.deviceId === deviceId)
      })),
      serverTime: new Date()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Simple notification system');
});

module.exports = app;
