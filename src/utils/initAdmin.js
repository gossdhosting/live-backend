import User from '../models/User.js';
import logger from './logger.js';

// Initialize default admin user
export const initAdminUser = async () => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

    // Check if admin exists
    const existingAdmin = User.findByEmail(adminEmail);

    if (!existingAdmin) {
      await User.create({
        email: adminEmail,
        password: adminPassword,
        name: 'Admin',
        role: 'admin',
      });

      logger.info('Default admin user created', { email: adminEmail });
      console.log('');
      console.log('='.repeat(60));
      console.log('DEFAULT ADMIN CREDENTIALS');
      console.log('='.repeat(60));
      console.log(`Email: ${adminEmail}`);
      console.log(`Password: ${adminPassword}`);
      console.log('='.repeat(60));
      console.log('⚠️  CHANGE THESE CREDENTIALS IMMEDIATELY AFTER FIRST LOGIN');
      console.log('='.repeat(60));
      console.log('');
    }
  } catch (error) {
    logger.error('Failed to initialize admin user', { error: error.message });
  }
};
