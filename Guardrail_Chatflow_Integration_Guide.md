# Adding Guardrail Safety to Your Chatflow Bot

**For: AM Notary LLC**

---

## What This Does

Every time your Chatflow bot answers a customer, Guardrail checks the response for accuracy. Good answers go through clean. Risky answers get a soft "call us for details" note — so customers always get help, and you get more calls.

---

## Step 1: Get Your API Key

1. Open: **https://guardrail-mvp-production.up.railway.app/developer.html**
2. Enter your email → you'll get a key like `gr_live_abc123...`
3. **Save this key** — you'll need it in Step 2

---

## Step 2: Create the Guardrail Tool in Chatflow

1. Open your **Chatflow dashboard**
2. In the sidebar, click **Tools** → **Create New**
3. Fill in these fields:

**Name:**
```
guardrailSafetyCheck
```

**Description:**
```
Checks AI responses for accuracy and safety before showing them to customers. Returns the original response with a safety disclaimer if needed.
```

**Input Variables:**
- Add variable `aiResponse` (type: string) — *The AI's generated response*
- Add variable `customerQuestion` (type: string) — *The customer's original question*

**JavaScript Function — paste this entire block:**

```javascript
const fetch = require('node-fetch');

const GUARDRAIL_KEY = 'PASTE_YOUR_API_KEY_HERE';
const GUARDRAIL_URL = 'https://guardrail-mvp-production.up.railway.app/api/check';

const response = await fetch(GUARDRAIL_URL, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Guardrail-Key': GUARDRAIL_KEY
    },
    body: JSON.stringify({
        text: $aiResponse,
        userQuery: $customerQuestion
    })
});

const score = await response.json();

if (score.decision === 'escalate') {
    return $aiResponse +
        '\n\n📞 For accuracy, I\'d recommend confirming with our team. ' +
        'Call us or book at amnotaryllc.com';
}

if (score.decision === 'flag') {
    return $aiResponse +
        '\n\nℹ️ Have more questions? We\'re available 24/7 — call us anytime!';
}

return $aiResponse;
```

4. **Replace `PASTE_YOUR_API_KEY_HERE`** with your key from Step 1
5. Click **Save**

---

## Step 3: Connect It to Your Chatflow

1. Open your chatflow (the bot you built for your website)
2. Find the node where your AI generates its response (usually a **Chat Model** or **Chain** node)
3. Add a **Custom Tool** node to the canvas
4. Select **guardrailSafetyCheck** from the dropdown
5. Connect:
   - `aiResponse` → wire it to the output of your AI node
   - `customerQuestion` → wire it to the user's input
6. Make the Custom Tool's output the **final response** shown to the customer
7. Click **Save** and test it

---

## Step 4: Test It

In your Chatflow's chat preview, try these:

**Safe question:**
> "What areas do you serve?"

→ Should show the answer with no disclaimer ✅

**Risky question:**
> "Can I notarize my own documents?"

→ Should show the answer + *"Call us or book at amnotaryllc.com"* 📞

---

## Step 5: View Your Dashboard

See every scored response at:

👉 **https://guardrail-mvp-production.up.railway.app/developer.html**

Enter your API key to see:
- Total responses scored
- How many were clean vs flagged
- Confidence scores for each response

---

## What Customers See

| AI Confidence | Customer Experience |
|--------------|-------------------|
| **High** (75%+) | Just the answer — clean, no extra text |
| **Medium** (50-75%) | Answer + *"Have more questions? Call us anytime!"* |
| **Low** (below 50%) | Answer + *"I'd recommend confirming with our team"* |

Nobody gets blocked. Every customer gets an answer. Risky ones get a gentle nudge to call — which drives more leads to you.

---

**Questions?** Contact: symehmoo@gmail.com
