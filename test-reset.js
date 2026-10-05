// test-reset.js
const testReset = async () => {
    // Switch to "http://localhost:3000/reset-license" if testing against your local server
    const url = "https://win11-license.onrender.com/reset-license";

    // Use a product_key that currently exists in your Firestore collection:
    const currentKey = "04FEC82EB44C66E2"; 
    const newDeviceInstallationId = "E2E_TEST_99";

    const sendRequest = async (label, key, newId) => {
        console.log(`\n--> ${label}...`);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ productKey: key, newInstallationId: newId })
            });

            const rawText = await response.text();
            let parsedData;
            try {
                parsedData = JSON.parse(rawText);
            } catch {
                parsedData = rawText; // Fall back to raw HTML if server didn't send JSON
            }

            console.log(`HTTP Status: ${response.status}`);
            console.log("Response Body:", parsedData);
            return { status: response.status, data: parsedData };
        } catch (err) {
            console.error("Network request failed:", err.message);
        }
    };

    // Attempt 1: Valid transfer
    const attempt1 = await sendRequest("Attempting 1st Transfer", currentKey, newDeviceInstallationId);

    // Attempt 2: Blocked transfer
    if (attempt1?.data?.newProductKey) {
        await sendRequest("Attempting 2nd Transfer (Should Be Blocked)", attempt1.data.newProductKey, "ANOTHER_PC_BLOCKED_888");
    } else {
        await sendRequest("Attempting 2nd Transfer (Should Be Blocked)", currentKey, "ANOTHER_PC_BLOCKED_888");
    }
};

testReset();