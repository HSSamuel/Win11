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
                let actualEmail = verifyData.data.customer.email;

                // Strip Flutterwave's 'ravesb_' proxy mask to get the real email
                if (actualEmail.startsWith('ravesb_')) {
                    const parts = actualEmail.split('_');
                    if (parts.length >= 3) {
                        actualEmail = parts.slice(2).join('_'); 
                    }
                }
                
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

                // Check what the exact email string is before sending
                console.log("Attempting to deliver license to exactly:", actualEmail);

                // Send Email via Resend
                try {
                    await resend.emails.send({
                        from: 'Win11 PC Launcher <noreply@asconalumni.org>', 
                        to: actualEmail,
                        subject: 'Your Win11 PC Launcher Pro License Key',
                        text: `Thank you for your purchase!\n\nYour Installation ID: ${installationId}\nYour Product Key: ${productKey}\n\nPlease keep this key secure and enter it into the launcher to activate Pro features.`
                    });
                    
                    console.log(`License generated and emailed successfully to ${actualEmail}`);
                } catch (emailError) {
                    console.error("Failed to send email via Resend:", emailError);
                }
            }
        } catch (error) {
            console.error("Verification API failed:", error);
        }
    }

    res.sendStatus(200);
});

app.post("/reset-license", async (req, res) => {
    const { productKey, newInstallationId } = req.body;

    if (!productKey || !newInstallationId) {
        return res.status(400).json({ error: "Missing Product Key or New Installation ID" });
    }

    try {
        // 1. Locate the license using the current product key
        const licensesRef = db.collection("licenses");
        const snapshot = await licensesRef.where("product_key", "==", productKey).get();

        if (snapshot.empty) {
            return res.status(404).json({ error: "Invalid Product Key" });
        }

        const doc = snapshot.docs[0];
        const licenseData = doc.data();
        const currentResetCount = licenseData.reset_count || 0;

        // 2. Enforce strict 1-time transfer limit
        if (currentResetCount >= 1) {
            return res.status(403).json({ 
                error: "Limit Reached", 
                message: "This license has already been transferred to a new PC. The maximum limit of 1 transfer has been reached. Please purchase a new license." 
            });
        }

        // 3. Generate the new product key matching the new Installation ID
        const rawString = `${newInstallationId}_${APP_SECRET}`;
        const newProductKey = crypto.createHash('sha256')
                                     .update(rawString)
                                     .digest('hex')
                                     .substring(0, 16)
                                     .toUpperCase();

        // 4. Update the Firestore record
        await doc.ref.update({
            installation_id: newInstallationId,
            product_key: newProductKey,
            reset_count: currentResetCount + 1,
            last_reset_date: FieldValue.serverTimestamp()
        });

        // 5. Email the updated key to the customer's original email
        try {
            await resend.emails.send({
                from: 'Win11 PC Launcher <noreply@asconalumni.org>',
                to: licenseData.email,
                subject: 'Your Updated Win11 PC Launcher Pro License Key',
                text: `Your license transfer was successful!\n\nNew Installation ID: ${newInstallationId}\nNew Product Key: ${newProductKey}\n\nNote: This license has now used its 1 allowed device transfer. No further transfers are permitted.`
            });
        } catch (emailErr) {
            console.error("Failed to email updated key:", emailErr);
        }

        console.log(`License transferred to PC: ${newInstallationId}. Reset count: ${currentResetCount + 1}`);

        return res.status(200).json({ 
            message: "License successfully transferred.",
            newProductKey: newProductKey 
        });

    } catch (error) {
        console.error("Reset Error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));