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
      const smtp_from_name = settings.smtp_from_name || 'RexStream';
      const template = settings.email_template_registration || `
        <h2>Welcome to RexStream!</h2>
        <p>Hi ${name},</p>
        <p>Thank you for registering with RexStream. Your account has been created successfully.</p>
        <p>You can now log in and start streaming to multiple platforms simultaneously.</p>
        <p>Best regards,<br>The RexStream Team</p>
      `;

      const htmlContent = await this.applyTemplate(template);

      await transporter.sendMail({
        from: `"${smtp_from_name}" <${smtp_from_email}>`,
        to: email,
        subject: 'Welcome to RexStream',
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
      const smtp_from_name = settings.smtp_from_name || 'RexStream';
      const frontendUrl = process.env.FRONTEND_URL || 'https://panel.rexstream.net';
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
        <p>Best regards,<br>The RexStream Team</p>
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
      const smtp_from_name = settings.smtp_from_name || 'RexStream';
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

  // Send subscription-related emails
  static async sendSubscriptionEmail(to, templateType, data = {}) {
    try {
      const transporter = await this.getTransporter();
      if (!transporter) {
        logger.warn('Cannot send subscription email: SMTP not configured');
        return { success: false, message: 'SMTP not configured' };
      }

      const settings = await this.getSettingsMap();
      const smtp_from_email = settings.smtp_from_email || 'noreply@localhost';
      const smtp_from_name = settings.smtp_from_name || 'RexStream';

      const templates = {
        activated: {
          subject: 'Subscription Activated - Welcome to Premium!',
          html: `
            <h2>Welcome to ${data.planName}!</h2>
            <p>Your subscription has been activated successfully.</p>
            <p><strong>Billing cycle:</strong> ${data.billingCycle}</p>
            <p>Thank you for subscribing!</p>
            <p>If you have any questions, please don't hesitate to contact us.</p>
          `,
        },
        cancelled: {
          subject: 'Subscription Cancelled',
          html: `
            <h2>Subscription Cancelled</h2>
            <p>Your subscription has been cancelled.</p>
            <p>You will still have access to premium features until the end of your current billing period.</p>
            <p>We're sorry to see you go! If you change your mind, you can resubscribe anytime.</p>
          `,
        },
        payment_success: {
          subject: 'Payment Successful',
          html: `
            <h2>Payment Received</h2>
            <p>We've successfully processed your payment.</p>
            <p><strong>Amount:</strong> $${data.amount} ${data.currency}</p>
            <p><a href="${data.invoiceUrl}" style="background-color: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">View Invoice</a></p>
            <p>Thank you for your continued subscription!</p>
          `,
        },
        payment_failed: {
          subject: 'Payment Failed - Action Required',
          html: `
            <h2>Payment Failed</h2>
            <p>We were unable to process your payment of $${data.amount} ${data.currency}.</p>
            <p>Please update your payment method to avoid service interruption.</p>
            <p><a href="${data.invoiceUrl}" style="background-color: #e74c3c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Update Payment Method</a></p>
            <p>If you have any questions, please contact our support team.</p>
          `,
        },
        trial_ending: {
          subject: 'Your Trial is Ending Soon',
          html: `
            <h2>Trial Ending Soon</h2>
            <p>Your trial period will end on <strong>${data.trialEndDate}</strong>.</p>
            <p>To continue enjoying premium features, your payment method will be charged automatically.</p>
            <p>If you don't wish to continue, you can cancel your subscription anytime before the trial ends.</p>
          `,
        },
        renewal_reminder: {
          subject: 'Subscription Renewal Reminder',
          html: `
            <h2>Subscription Renewal</h2>
            <p>Your subscription will renew on <strong>${data.renewalDate}</strong>.</p>
            <p><strong>Amount:</strong> $${data.amount} ${data.currency}</p>
            <p>We'll charge your payment method on file automatically.</p>
            <p>If you need to update your payment method or cancel, please do so before the renewal date.</p>
          `,
        },
        upgraded: {
          subject: 'Plan Upgraded Successfully',
          html: `
            <h2>🎉 Plan Upgraded!</h2>
            <p>Your subscription has been upgraded to <strong>${data.planName}</strong>.</p>
            <p><strong>Billing cycle:</strong> ${data.billingCycle}</p>
            <p>You now have access to enhanced features and higher limits.</p>
            <p>Thank you for upgrading!</p>
          `,
        },
        downgraded: {
          subject: 'Plan Changed',
          html: `
            <h2>Plan Updated</h2>
            <p>Your subscription has been changed to <strong>${data.planName}</strong>.</p>
            <p><strong>Billing cycle:</strong> ${data.billingCycle}</p>
            <p>Your new plan features will take effect immediately.</p>
          `,
        },
        admin_payment_failed: {
          subject: `[ADMIN] Payment Failed for User ${data.userEmail}`,
          html: `
            <h2>Payment Failed Alert</h2>
            <p><strong>User:</strong> ${data.userEmail} (ID: ${data.userId})</p>
            <p><strong>Failed Amount:</strong> $${data.amount}</p>
            <p>Action may be required to follow up with the customer.</p>
          `,
        },
        admin_new_subscription: {
          subject: `[ADMIN] New Subscription - ${data.planName}`,
          html: `
            <h2>New Subscription</h2>
            <p><strong>User:</strong> ${data.userEmail} (ID: ${data.userId})</p>
            <p><strong>Plan:</strong> ${data.planName}</p>
            <p><strong>Billing:</strong> ${data.billingCycle}</p>
            <p><strong>Amount:</strong> $${data.amount} ${data.currency}</p>
          `,
        },
      };

      const template = templates[templateType];
      if (!template) {
        logger.error('Email template not found', { templateType });
        return { success: false, message: 'Template not found' };
      }

      const htmlContent = await this.applyTemplate(template.html);

      await transporter.sendMail({
        from: `"${smtp_from_name}" <${smtp_from_email}>`,
        to,
        subject: template.subject,
        html: htmlContent,
      });

      logger.info('Subscription email sent', { to, templateType });
      return { success: true };
    } catch (error) {
      logger.error('Failed to send subscription email', {
        error: error.message,
        to,
        templateType,
      });
      return { success: false, message: error.message };
    }
  }
}

export default EmailService;

// Export individual function for webhook use
export async function sendSubscriptionEmail(to, templateType, data) {
  return await EmailService.sendSubscriptionEmail(to, templateType, data);
}
