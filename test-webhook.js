fetch('http://localhost:3000/flutterwave', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        // This must match the FLW_SECRET_HASH in your .env file
        'verif-hash': 'win11_custom_hash2026' 
    },
    body: JSON.stringify({
        event: 'charge.completed',
        data: {
            status: 'successful',
            tx_ref: 'TX_TEST_1001', // A fake transaction reference
            customer: { 
                email: 'smkmayomisamuel@gmail.com' 
            },
            meta: { 
                'Your Installation ID': 'ABC123XYZ0' // A fake device ID
            }
        }
    })
})
.then(async res => {
    console.log('Server responded with status:', res.status);
    if (res.status === 200) {
        console.log('✅ Webhook successfully processed!');
    } else {
        console.log('❌ Webhook failed. Check server console for errors.');
    }
})
.catch(err => console.error('Error connecting to server:', err));