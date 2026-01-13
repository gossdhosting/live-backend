import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function checkInvoice() {
  try {
    const invoice = await stripe.invoices.retrieve('in_1SpFsWSIE8vhhT3lYw3dAjQc', {
      expand: ['lines.data.price', 'lines.data.proration_details']
    });

    console.log('\n=== Invoice Details ===');
    console.log('ID:', invoice.id);
    console.log('Total:', invoice.total / 100);
    console.log('Amount Paid:', invoice.amount_paid / 100);
    console.log('Status:', invoice.status);
    console.log('Billing Reason:', invoice.billing_reason);

    console.log('\n=== Line Items ===');
    invoice.lines.data.forEach((item, index) => {
      console.log(`\nItem ${index + 1}:`);
      console.log('  Description:', item.description);
      console.log('  Amount:', item.amount / 100);
      console.log('  Quantity:', item.quantity);
      console.log('  Proration:', item.proration);
      if (item.period) {
        console.log('  Period Start:', new Date(item.period.start * 1000).toISOString());
        console.log('  Period End:', new Date(item.period.end * 1000).toISOString());
      }
    });
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkInvoice();
