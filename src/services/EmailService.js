import nodemailer from 'nodemailer';
import Settings from '../models/Settings.js';
import logger from '../utils/logger.js';

class EmailService {
  static transporter = null;

  // Helper to get settings as a map
  static async getSettingsMap() {
    const settings = await Settings.getAll();
    const map = {};
    settings.forEach(s => {
      map[s.key] = s.value;
    });
    return map;
  }

  // Initialize transporter with current SMTP settings
  static async getTransporter() {
    const settings = await this.getSettingsMap();
    const smtp_host = settings.smtp_host;
    const smtp_port = settings.smtp_port;
    const smtp_user = settings.smtp_user;
    const smtp_password = settings.smtp_password;
    const smtp_secure = settings.smtp_secure === '1';

    if (!smtp_host || !smtp_port || !smtp_user || !smtp_password) {
      logger.warn('SMTP not fully configured');
      return null;
    }

    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: smtp_host,
        port: parseInt(smtp_port),
        secure: smtp_secure,
        auth: {
          user: smtp_user,
          pass: smtp_password,
        },
      });
    }

    return this.transporter;
  }

  // Reset transporter (call when settings change)
  static resetTransporter() {
    this.transporter = null;
  }

  // Apply email template (header + content + footer)
  static async applyTemplate(content) {
    const settings = await this.getSettingsMap();
    const header = settings.email_header || '';
    const footer = settings.email_footer || '';

    return `
      ${header}
      ${content}
      ${footer}
    `;
  }

  // Send registration email
  static async sendRegistrationEmail(email, name) {
    try {
      const transporter = await this.getTransporter();
      if (!transporter) {
        logger.warn('Cannot send registration email: SMTP not configured');
        return { success: false, message: 'SMTP not configured' };
      }

      const settings = await this.getSettingsMap();
      const smtp_from_email = settings.smtp_from_email || 'noreply@localhost';
      const smtp_from_name = settings.smtp_from_name || 'ZebCast';
      const template = settings.email_template_registration || `
        <h2>Welcome to ZebCast!</h2>
        <p>Hi ${name},</p>
        <p>Thank you for registering with ZebCast. Your account has been created successfully.</p>
        <p>You can now log in and start streaming to multiple platforms simultaneously.</p>
        <p>Best regards,<br>The ZebCast Team</p>
      `;

      const htmlContent = await this.applyTemplate(template);

      await transporter.sendMail({
        from: `"${smtp_from_name}" <${smtp_from_email}>`,
        to: email,
        subject: 'Welcome to ZebCast',
        html: htmlContent,
      });

      logger.info('Registration email sent', { email });
      return { success: true };
    } catch (error) {
      logger.error('Failed to send registration email', { error: error.message, email });
      return { success: false, message: error.message };
    }
  }

  // Send forgot password email
  static async sendForgotPasswordEmail(email, resetToken) {
    try {
      const transporter = await this.getTransporter();
      if (!transporter) {
        logger.warn('Cannot send forgot password email: SMTP not configured');
        return { success: false, message: 'SMTP not configured' };
      }

      const settings = await this.getSettingsMap();
      const smtp_from_email = settings.smtp_from_email || 'noreply@localhost';
      const smtp_from_name = settings.smtp_from_name || 'ZebCast';
      const frontendUrl = process.env.FRONTEND_URL || 'https://panel.zebcast.app';
      const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

      const template = settings.email_template_forgot_password || `
        <h2>Reset Your Password</h2>
        <p>Hi,</p>
        <p>You requested to reset your password. Click the button below to reset it:</p>
        <p style="margin: 20px 0;">
          <a href="${resetLink}" style="background-color: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Reset Password</a>
        </p>
        <p>If you didn't request this, you can safely ignore this email.</p>
        <p>This link will expire in 1 hour.</p>
        <p>Best regards,<br>The ZebCast Team</p>
      `;

      const htmlContent = await this.applyTemplate(template.replace('${resetLink}', resetLink));

      await transporter.sendMail({
        from: `"${smtp_from_name}" <${smtp_from_email}>`,
        to: email,
        subject: 'Reset Your Password',
        html: htmlContent,
      });

      logger.info('Forgot password email sent', { email });
      return { success: true };
    } catch (error) {
      logger.error('Failed to send forgot password email', { error: error.message, email });
      return { success: false, message: error.message };
    }
  }

  // Send admin notification
  static async sendAdminNotification(subject, content) {
    try {
      const settings = await this.getSettingsMap();
      const adminEmail = settings.admin_notification_email;
      if (!adminEmail) {
        logger.warn('Admin notification email not configured');
        return { success: false, message: 'Admin email not configured' };
      }

      const transporter = await this.getTransporter();
      if (!transporter) {
        logger.warn('Cannot send admin notification: SMTP not configured');
        return { success: false, message: 'SMTP not configured' };
      }

      const smtp_from_email = settings.smtp_from_email || 'noreply@localhost';
      const smtp_from_name = settings.smtp_from_name || 'ZebCast';
      const htmlContent = this.applyTemplate(content);

      await transporter.sendMail({
        from: `"${smtp_from_name}" <${smtp_from_email}>`,
        to: adminEmail,
        subject: subject,
        html: htmlContent,
      });

      logger.info('Admin notification sent', { subject });
      return { success: true };
    } catch (error) {
      logger.error('Failed to send admin notification', { error: error.message, subject });
      return { success: false, message: error.message };
    }
  }

  // Send new user signup notification to admin
  static async notifyAdminNewSignup(user) {
    const content = `
      <h2>New User Registration</h2>
      <p>A new user has registered:</p>
      <ul>
        <li><strong>Name:</strong> ${user.name}</li>
        <li><strong>Email:</strong> ${user.email}</li>
        <li><strong>Auth Method:</strong> ${user.auth_provider || 'local'}</li>
        <li><strong>Plan:</strong> ${user.plan_name || 'N/A'}</li>
        <li><strong>Registered:</strong> ${new Date().toLocaleString()}</li>
      </ul>
    `;

    return await this.sendAdminNotification('New User Registration', content);
  }
}

export default EmailService;
