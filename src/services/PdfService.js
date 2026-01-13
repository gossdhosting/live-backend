import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PdfService {
  static async generateInvoice(invoiceData) {
    try {
      const {
        invoiceId,
        invoiceNumber,
        date,
        dueDate,
        customer,
        items,
        subtotal,
        tax,
        total,
        currency = 'USD',
        status,
      } = invoiceData;

      // Create invoices directory if it doesn't exist
      const invoicesDir = path.join(process.cwd(), 'invoices');
      if (!fs.existsSync(invoicesDir)) {
        fs.mkdirSync(invoicesDir, { recursive: true });
      }

      const filename = `invoice-${invoiceNumber || invoiceId}.pdf`;
      const filepath = path.join(invoicesDir, filename);

      return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(filepath);

        stream.on('finish', () => {
          logger.info('Invoice PDF generated', { invoiceId, filepath });
          resolve(filepath);
        });

        stream.on('error', (error) => {
          logger.error('Failed to generate invoice PDF', { error: error.message });
          reject(error);
        });

        doc.pipe(stream);

        // Header
        doc
          .fontSize(20)
          .text('INVOICE', 50, 45, { align: 'right' })
          .fontSize(10)
          .text(`Invoice #: ${invoiceNumber || invoiceId}`, 50, 70, { align: 'right' })
          .text(`Date: ${this.formatDate(date)}`, 50, 85, { align: 'right' });

        if (status) {
          doc
            .fontSize(12)
            .fillColor(status === 'paid' ? '#10b981' : '#ef4444')
            .text(status.toUpperCase(), 50, 100, { align: 'right' })
            .fillColor('#000000');
        }

        // Company/Platform Info
        doc
          .fontSize(16)
          .text('RexStream', 50, 45)
          .fontSize(10)
          .text('Multi-Channel Streaming Platform', 50, 65)
          .text('support@rexstream.net', 50, 80);

        // Customer Info
        doc
          .fontSize(12)
          .text('Bill To:', 50, 140)
          .fontSize(10)
          .text(customer.name || 'N/A', 50, 160)
          .text(customer.email, 50, 175);

        if (customer.address) {
          doc.text(customer.address, 50, 190);
        }

        // Due Date
        if (dueDate) {
          doc
            .fontSize(10)
            .text(`Due Date: ${this.formatDate(dueDate)}`, 50, 220, { align: 'right' });
        }

        // Line Items Table
        const tableTop = 280;
        doc
          .fontSize(10)
          .text('Description', 50, tableTop)
          .text('Amount', 450, tableTop, { width: 90, align: 'right' });

        doc
          .moveTo(50, tableTop + 15)
          .lineTo(550, tableTop + 15)
          .stroke();

        let yPosition = tableTop + 30;

        items.forEach((item) => {
          doc
            .fontSize(10)
            .text(item.description, 50, yPosition)
            .text(this.formatCurrency(item.amount, currency), 450, yPosition, {
              width: 90,
              align: 'right',
            });

          if (item.details) {
            yPosition += 15;
            doc
              .fontSize(8)
              .fillColor('#666666')
              .text(item.details, 60, yPosition)
              .fillColor('#000000');
          }

          yPosition += 25;
        });

        // Totals
        const totalsTop = yPosition + 20;

        doc
          .moveTo(350, totalsTop)
          .lineTo(550, totalsTop)
          .stroke();

        yPosition = totalsTop + 15;

        doc
          .fontSize(10)
          .text('Subtotal:', 350, yPosition)
          .text(this.formatCurrency(subtotal, currency), 450, yPosition, {
            width: 90,
            align: 'right',
          });

        if (tax && tax > 0) {
          yPosition += 20;
          doc
            .text('Tax:', 350, yPosition)
            .text(this.formatCurrency(tax, currency), 450, yPosition, {
              width: 90,
              align: 'right',
            });
        }

        yPosition += 25;
        doc
          .moveTo(350, yPosition)
          .lineTo(550, yPosition)
          .stroke();

        yPosition += 15;
        doc
          .fontSize(12)
          .text('Total:', 350, yPosition)
          .text(this.formatCurrency(total, currency), 450, yPosition, {
            width: 90,
            align: 'right',
          });

        // Footer
        const footerTop = 700;
        doc
          .fontSize(8)
          .fillColor('#666666')
          .text('Thank you for your business!', 50, footerTop, { align: 'center' })
          .text(
            'If you have any questions about this invoice, please contact support@rexstream.net',
            50,
            footerTop + 15,
            { align: 'center' }
          )
          .fillColor('#000000');

        doc.end();
      });
    } catch (error) {
      logger.error('Failed to generate invoice', { error: error.message });
      throw error;
    }
  }

  static formatCurrency(amount, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount);
  }

  static formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  static async generateInvoiceFromStripe(stripeInvoice, user, plan) {
    const items = [];

    // Add line items
    stripeInvoice.lines.data.forEach((line) => {
      let description = line.description || 'Subscription';
      let details = '';

      if (line.period) {
        details = `Period: ${this.formatDate(new Date(line.period.start * 1000))} - ${this.formatDate(
          new Date(line.period.end * 1000)
        )}`;
      }

      items.push({
        description,
        details,
        amount: line.amount / 100, // Convert from cents
      });
    });

    const invoiceData = {
      invoiceId: stripeInvoice.id,
      invoiceNumber: stripeInvoice.number,
      date: new Date(stripeInvoice.created * 1000),
      dueDate: stripeInvoice.due_date ? new Date(stripeInvoice.due_date * 1000) : null,
      customer: {
        name: user.name,
        email: user.email,
      },
      items,
      subtotal: stripeInvoice.subtotal / 100,
      tax: stripeInvoice.tax ? stripeInvoice.tax / 100 : 0,
      total: stripeInvoice.total / 100,
      currency: stripeInvoice.currency,
      status: stripeInvoice.status === 'paid' ? 'paid' : 'unpaid',
    };

    return await this.generateInvoice(invoiceData);
  }
}

export default PdfService;
