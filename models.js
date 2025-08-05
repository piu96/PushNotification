
const mongoose = require('mongoose');

/**
 * MongoDB schemas for cross-device notification system
 * Simple, practical data structures without complex vector clocks
 */

// Device schema - tracks user devices
const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  deviceName: {
    type: String,
    default: 'Unknown Device'
  },
  deviceType: {
    type: String,
    enum: ['mobile', 'desktop', 'tablet', 'web'],
    default: 'mobile'
  },
  isOnline: {
    type: Boolean,
    default: true
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  pushToken: {
    type: String, // FCM/APNS token for push notifications
    sparse: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound indexes for better query performance
deviceSchema.index({ userId: 1, isOnline: 1 });
deviceSchema.index({ userId: 1, lastSeen: -1 });

// NEW: Separate DeviceNotificationState schema for massive scale
const deviceNotificationStateSchema = new mongoose.Schema({
  notificationId: {
    type: String,
    required: true,
    index: true
  },
  deviceId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  readAt: {
    type: Date,
    sparse: true
  },
  lastSyncAt: {
    type: Date,
    default: Date.now
  },
  version: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

// Critical compound indexes for performance
deviceNotificationStateSchema.index({ notificationId: 1, deviceId: 1 }, { unique: true });
deviceNotificationStateSchema.index({ userId: 1, isRead: 1 });
deviceNotificationStateSchema.index({ deviceId: 1, lastSyncAt: -1 });
deviceNotificationStateSchema.index({ notificationId: 1, isRead: 1 });

// TTL index to auto-delete old device states after 90 days
deviceNotificationStateSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

// Notification schema - main notification data (OPTIMIZED for massive scale)
const notificationSchema = new mongoose.Schema({
  notificationId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  content: {
    type: String,
    required: true,
    maxlength: 500
  },
  title: {
    type: String,
    maxlength: 100
  },
  type: {
    type: String,
    enum: ['message', 'alert', 'reminder', 'system'],
    default: 'message'
  },
  
  // Global read status (race condition prevention)
  isGloballyRead: {
    type: Boolean,
    default: false,
    index: true
  },
  globalReadAt: {
    type: Date,
    sparse: true
  },
  globalReadByDevice: {
    type: String,
    sparse: true
  },
  
  // REMOVED: deviceStates array (now in separate collection)
  // This dramatically improves performance for users with many devices
  
  // Push notification tracking (prevent duplicates)
  pushSentTo: [{
    type: String // Array of device IDs that received push
  }],
  pushSentAt: {
    type: Date,
    sparse: true
  },
  
  // Simple conflict resolution
  version: {
    type: Number,
    default: 1
  },
  
  // Metadata
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal'
  },
  expiresAt: {
    type: Date,
    sparse: true
  }
}, {
  timestamps: true // Adds createdAt and updatedAt automatically
});

// Compound indexes for efficient queries
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isGloballyRead: 1 });
notificationSchema.index({ expiresAt: 1 }, { sparse: true });

// User schema - basic user information
const userSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  username: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  
  // Notification preferences
  notificationSettings: {
    enablePush: {
      type: Boolean,
      default: true
    },
    enableEmail: {
      type: Boolean,
      default: false
    },
    quietHours: {
      start: {
        type: String, // Format: "22:00"
        default: "22:00"
      },
      end: {
        type: String, // Format: "08:00"
        default: "08:00"
      },
      timezone: {
        type: String,
        default: "UTC"
      }
    }
  },
  
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Push queue schema - for reliable push delivery
const pushQueueSchema = new mongoose.Schema({
  queueId: {
    type: String,
    required: true,
    unique: true
  },
  notificationId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  deviceIds: [{
    type: String,
    required: true
  }],
  content: {
    title: String,
    body: String,
    data: mongoose.Schema.Types.Mixed
  },
  
  // Queue management
  status: {
    type: String,
    enum: ['pending', 'processing', 'sent', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 3
  },
  lastAttemptAt: {
    type: Date,
    sparse: true
  },
  scheduledAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  // Error tracking
  errors: [{
    attempt: Number,
    error: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    _id: false
  }]
}, {
  timestamps: true
});

// TTL index to auto-delete old completed/failed push queue items after 7 days
pushQueueSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 604800 });

// Sync log schema - track device sync operations
const syncLogSchema = new mongoose.Schema({
  syncId: {
    type: String,
    required: true,
    unique: true
  },
  deviceId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  
  // Sync details
  syncType: {
    type: String,
    enum: ['full', 'incremental', 'conflict_resolution'],
    default: 'incremental'
  },
  lastSyncAt: {
    type: Date,
    required: true
  },
  notificationsCount: {
    type: Number,
    default: 0
  },
  conflictsResolved: {
    type: Number,
    default: 0
  },
  
  // Performance metrics
  duration: {
    type: Number, // milliseconds
    min: 0
  },
  dataSize: {
    type: Number, // bytes
    min: 0
  }
}, {
  timestamps: true
});

// TTL index to auto-delete old sync logs after 30 days
syncLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

// Schema methods

// Device methods
deviceSchema.methods.updateLastSeen = function() {
  this.lastSeen = new Date();
  this.isOnline = true;
  return this.save();
};

deviceSchema.methods.setOffline = function() {
  this.isOnline = false;
  return this.save();
};

// DeviceNotificationState methods
deviceNotificationStateSchema.statics.markAsReadAtomic = async function(notificationId, deviceId, userId, timestamp = new Date()) {
  // Atomic operation to prevent race conditions
  const result = await this.findOneAndUpdate(
    {
      notificationId,
      deviceId,
      $or: [
        { isRead: false },
        { readAt: { $lt: timestamp } }
      ]
    },
    {
      $set: {
        isRead: true,
        readAt: timestamp,
        lastSyncAt: new Date()
      },
      $inc: { version: 1 },
      $setOnInsert: {
        notificationId,
        deviceId,
        userId,
        createdAt: new Date()
      }
    },
    {
      upsert: true,
      new: true,
      runValidators: true
    }
  );
  
  return result;
};

deviceNotificationStateSchema.statics.getDeviceState = async function(notificationId, deviceId) {
  return await this.findOne({ notificationId, deviceId });
};

deviceNotificationStateSchema.statics.getNotificationStates = async function(notificationId) {
  return await this.find({ notificationId });
};

deviceNotificationStateSchema.statics.getUserUnreadCount = async function(userId) {
  return await this.countDocuments({ userId, isRead: false });
};

// Updated Notification methods (now work with separate DeviceNotificationState collection)
notificationSchema.methods.shouldSendPushToDevice = function(deviceId) {
  // Don't send push if:
  // 1. Already sent to this device
  // 2. Notification is globally read
  
  if (this.pushSentTo.includes(deviceId)) return false;
  if (this.isGloballyRead) return false;
  
  return true;
};

notificationSchema.methods.markPushSent = function(deviceId) {
  if (!this.pushSentTo.includes(deviceId)) {
    this.pushSentTo.push(deviceId);
  }
  
  if (!this.pushSentAt) {
    this.pushSentAt = new Date();
  }
};

// Create and export models
const Device = mongoose.model('Device', deviceSchema);
const DeviceNotificationState = mongoose.model('DeviceNotificationState', deviceNotificationStateSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const User = mongoose.model('User', userSchema);
const PushQueue = mongoose.model('PushQueue', pushQueueSchema);
const SyncLog = mongoose.model('SyncLog', syncLogSchema);

module.exports = {
  Device,
  DeviceNotificationState, // NEW: Separate collection for massive scale
  Notification,
  User,
  PushQueue,
  SyncLog,
  
  // Export schemas for testing
  deviceSchema,
  deviceNotificationStateSchema, // NEW schema
  notificationSchema,
  userSchema,
  pushQueueSchema,
  syncLogSchema
};
