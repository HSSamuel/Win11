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
        const transactionId = String(payload.data.id); 
        const txRef = payload.data.tx_ref; 

        try {
            // Idempotency check: prevent processing the same transaction multiple times
            const docRef = db.collection("licenses").doc(txRef);
            const docSnap = await docRef.get();
            
            if (docSnap.exists) {
                console.log(`Transaction ${txRef} already processed. Acknowledging webhook.`);
                return res.sendStatus(200);
            }

            // Ask Flutterwave for the complete, unmasked transaction data
            const verifyResponse = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            
            // Safe JSON parsing: prevent HTML/502 errors from crashing the route
            if (!verifyResponse.ok) {
                console.error("Flutterwave API returned HTTP", verifyResponse.status);
                return res.sendStatus(500); // Trigger a retry from Flutterwave
            }

            const verifyData = await verifyResponse.json();

            // Ensure the transaction was genuinely successful
            if (verifyData.status === "success" && verifyData.data.status === "successful") {
                
                // CRITICAL FIX: Dual-Currency Financial Validation
                const currency = verifyData.data.currency;
                const amount = verifyData.data.amount;

                const EXPECTED_NGN = 12000;
                const EXPECTED_USD = 10;

                let isValidAmount = false;
                if (currency === "NGN" && amount >= EXPECTED_NGN) {
                    isValidAmount = true;
                } else if (currency === "USD" && amount >= EXPECTED_USD) {
                    isValidAmount = true;
                }

                if (!isValidAmount) {
                    console.error(`Invalid payment amount or currency! Expected >= ${EXPECTED_NGN} NGN or >= ${EXPECTED_USD} USD, but got ${amount} ${currency}`);
                    return res.status(400).send('Invalid payment amount or currency');
                }

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

                // Save to Database first to secure the state
                await docRef.set({
                    transaction_id: txRef,
                    email: actualEmail,
                    installation_id: installationId,
                    product_key: productKey,
                    reset_count: 0,
                    currency: currency,
                    amount_paid: amount,
                    created_at: FieldValue.serverTimestamp(),
                    last_reset_date: null
                });

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
                    // Return 200 to Flutterwave because payment succeeded and DB is updated securely
                }
            }
        } catch (error) {
            console.error("Verification API failed:", error);
            return res.sendStatus(500); // Trigger a retry for unexpected errors
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

        // 4. Email the updated key FIRST to prevent DB updates causing a "black hole"
        try {
            await resend.emails.send({
                from: 'Win11 PC Launcher <noreply@asconalumni.org>',
                to: licenseData.email,
                subject: 'Your Updated Win11 PC Launcher Pro License Key',
                text: `Your license transfer was successful!\n\nNew Installation ID: ${newInstallationId}\nNew Product Key: ${newProductKey}\n\nNote: This license has now used its 1 allowed device transfer. No further transfers are permitted.`
            });
        } catch (emailErr) {
            console.error("Failed to email updated key:", emailErr);
            return res.status(500).json({ error: "Failed to dispatch email. Reset aborted to prevent lock-out." });
        }

        // 5. Update the Firestore record ONLY after successful email dispatch
        await doc.ref.update({
            installation_id: newInstallationId,
            product_key: newProductKey,
            reset_count: currentResetCount + 1,
            last_reset_date: FieldValue.serverTimestamp()
        });

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