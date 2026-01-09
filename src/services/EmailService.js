import nodemailer from 'nodemailer';
import Settings from '../models/Settings.js';
import logger from '../utils/logger.js';

class EmailService {
  static transporter = null;

  // Initialize transporter with current SMTP settings
  static async getTransporter() {
    const smtp_host = Settings.get('smtp_host')?.value;
    const smtp_port = Settings.get('smtp_port')?.value;
    const smtp_user = Settings.get('smtp_user')?.value;
    const smtp_password = Settings.get('smtp_password')?.value;
    const smtp_secure = Settings.get('smtp_secure')?.value === '1';

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
  static applyTemplate(content) {
    const header = Settings.get('email_header')?.value || '';
    const footer = Settings.get('email_footer')?.value || '';

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

      const smtp_from_email = Settings.get('smtp_from_email')?.value || 'noreply@localhost';
      const smtp_from_name = Settings.get('smtp_from_name')?.value || 'ZebCast';
      const template = Settings.get('email_template_registration')?.value || `
        <h2>Welcome to ZebCast!</h2>
        <p>Hi ${name},</p>
        <p>Thank you for registering with ZebCast. Your account has been created successfully.</p>
        <p>You can now log in and start streaming to multiple platforms simultaneously.</p>
        <p>Best regards,<br>The ZebCast Team</p>
      `;

      const htmlContent = this.applyTemplate(template);

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

      const smtp_from_email = Settings.get('smtp_from_email')?.value || 'noreply@localhost';
      const smtp_from_name = Settings.get('smtp_from_name')?.value || 'ZebCast';
      const frontendUrl = process.env.FRONTEND_URL || 'https://panel.zebcast.app';
      const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

      const template = Settings.get('email_template_forgot_password')?.value || `
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

      const htmlContent = this.applyTemplate(template.replace('${resetLink}', resetLink));

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
      const adminEmail = Settings.get('admin_notification_email')?.value;
      if (!adminEmail) {
        logger.warn('Admin notification email not configured');
        return { success: false, message: 'Admin email not configured' };
      }

      const transporter = await this.getTransporter();
      if (!transporter) {
        logger.warn('Cannot send admin notification: SMTP not configured');
        return { success: false, message: 'SMTP not configured' };
      }

      const smtp_from_email = Settings.get('smtp_from_email')?.value || 'noreply@localhost';
      const smtp_from_name = Settings.get('smtp_from_name')?.value || 'ZebCast';
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
