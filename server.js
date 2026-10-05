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
    console.log("FLUTTERWAVE PAYLOAD:", JSON.stringify(payload.data, null, 2));

    if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
        const email = payload.data.customer.email;
        const transactionId = payload.data.tx_ref;
        const installationId = payload.data.meta?.['Your Installation ID'];

if (!installationId) {
    console.error("Payment received, but Installation ID is missing. Transaction:", transactionId);
    return res.status(400).send('Missing Installation ID');
}

        const rawString = `${installationId}_${APP_SECRET}`;
        const productKey = crypto.createHash('sha256')
                                 .update(rawString)
                                 .digest('hex')
                                 .substring(0, 16)
                                 .toUpperCase();

        await db.collection("licenses").doc(transactionId).set({
            transaction_id: transactionId,
            email: email,
            installation_id: installationId,
            product_key: productKey,
            reset_count: 0,
            created_at: FieldValue.serverTimestamp(),
            last_reset_date: null
        });

        // Send email via Resend
        try {
            await resend.emails.send({
                from: 'Win11 PC Launcher <noreply@asconalumni.org>',
                to: email, 
                subject: 'Your Win11 PC Launcher Pro License Key',
                text: `Thank you for your purchase!\n\nYour Installation ID: ${installationId}\nYour Product Key: ${productKey}\n\nPlease keep this key secure and enter it into the launcher to activate Pro features.`
            });
            console.log(`License emailed successfully to ${email}`);
        } catch (error) {
            console.error("Failed to send email via Resend:", error);
        }
    }

    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));