const express = require("express");
const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
require("dotenv").config();

const app = express();
app.use(express.json());

// 1. Sanitize the private key to fix the formatting error
let rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY || "";
// Strip accidental surrounding quotes and force literal \n to become actual newlines
let cleanPrivateKey = rawPrivateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');

// 2. Initialize Firebase using the cleaned key
initializeApp({
    credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: cleanPrivateKey,
    })
});

const db = getFirestore();

// Match this to the secret in your Flutter app
const APP_SECRET = "Win11PCLauncherSecret"; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH || "win11_custom_hash2026";

app.post("/flutterwave", async (req, res) => {
    const signature = req.headers['verif-hash'] || req.headers['flutterwave-signature'];
    
    if (signature !== FLW_SECRET_HASH) {
        return res.status(401).send('Unauthorized signature');
    }

    const payload = req.body;

    if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
        const email = payload.data.customer.email;
        const transactionId = payload.data.tx_ref;
        const installationId = payload.data.meta['Your Installation ID'];

        if (!installationId) {
            return res.status(400).send('Missing Installation ID');
        }

        // Generate the 16-character Product Key
        const rawString = `${installationId}_${APP_SECRET}`;
        const productKey = crypto.createHash('sha256')
                                 .update(rawString)
                                 .digest('hex')
                                 .substring(0, 16)
                                 .toUpperCase();

        // Save the license data to Firestore
        await db.collection("licenses").doc(transactionId).set({
            transaction_id: transactionId,
            email: email,
            installation_id: installationId,
            product_key: productKey,
            reset_count: 0,
            created_at: FieldValue.serverTimestamp(),
            last_reset_date: null
        });
    }

    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});