const express = require("express");
const crypto = require("crypto");
const { Resend } = require("resend");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
require("dotenv").config();

const app = express();
app.use(express.json());

// Initialize Firebase
let cleanPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/^"|"$/g, '').replace(/\\n/g, '\n');
initializeApp({
    credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: cleanPrivateKey,
    })
});
const db = getFirestore();

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

const APP_SECRET = "Win11PCLauncherSecret"; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH || "win11_custom_hash2026";

app.post("/flutterwave", async (req, res) => {
    const signature = req.headers['verif-hash'] || req.headers['flutterwave-signature'];
    
    if (signature !== FLW_SECRET_HASH) {
        return res.status(401).send('Unauthorized signature');
    }

    const payload = req.body;

    if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
        const transactionId = payload.data.id; // The numeric ID to verify
        const txRef = payload.data.tx_ref; 

        try {
            // Ask Flutterwave for the complete, unmasked transaction data
            const verifyResponse = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            
            const verifyData = await verifyResponse.json();

            // Ensure the transaction was genuinely successful
            if (verifyData.status === "success" && verifyData.data.status === "successful") {
                const actualEmail = verifyData.data.customer.email;
                const meta = verifyData.data.meta || {};
                
                // Check for the ID (Flutterwave sometimes forces lowercase)
                const installationId = meta['Your Installation ID'] || meta['your_installation_id'];

                if (!installationId) {
                    console.error("Missing Installation ID in Meta:", meta);
                    return res.status(400).send('Missing Installation ID');
                }

                // Generate Product Key
                const rawString = `${installationId}_${APP_SECRET}`;
                const productKey = crypto.createHash('sha256')
                                         .update(rawString)
                                         .digest('hex')
                                         .substring(0, 16)
                                         .toUpperCase();

                // Save to Database
                await db.collection("licenses").doc(txRef).set({
                    transaction_id: txRef,
                    email: actualEmail,
                    installation_id: installationId,
                    product_key: productKey,
                    reset_count: 0,
                    created_at: FieldValue.serverTimestamp(),
                    last_reset_date: null
                });

                // Send Email via Resend
                await resend.emails.send({
                    from: 'Win11 PC Launcher <noreply@asconalumni.org>', // Change to your custom domain when verified
                    to: actualEmail,
                    subject: 'Your Win11 PC Launcher Pro License Key',
                    text: `Thank you for your purchase!\n\nYour Installation ID: ${installationId}\nYour Product Key: ${productKey}\n\nPlease keep this key secure and enter it into the launcher to activate Pro features.`
                });
                
                console.log(`License generated and emailed successfully to ${actualEmail}`);
            }
        } catch (error) {
            console.error("Verification API failed:", error);
        }
    }

    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));