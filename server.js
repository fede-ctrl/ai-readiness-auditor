require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');

const app = express();
// CORRECTED: Render provides the port via an environment variable.
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CORRECTED ENVIRONMENT VARIABLES ---
const CLIENT_ID = process.env.HUBSPOT_CLIENT_ID;
const CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
// CORRECTED: This now correctly uses the variable provided by Render, with a fallback for other environments.
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL;
const REDIRECT_URI = `${APP_BASE_URL}/api/oauth-callback`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- HubSpot API Helper ---
async function getValidAccessToken(portalId) {
    const { data: installation, error } = await supabase.from('hubspot_tokens').select('refresh_token, access_token, expires_at').eq('id', 1).single();
    if (error || !installation) throw new Error(`Could not find installation. Please reinstall the app by visiting the install URL.`);
    
    let { refresh_token, access_token, expires_at } = installation;
    
    if (new Date() > new Date(expires_at)) {
        console.log('Refreshing expired access token...');
        const response = await fetch('https://api.hubapi.com/oauth/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www.form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token }), });
        if (!response.ok) throw new Error('Failed to refresh access token');
        const newTokens = await response.json();
        access_token = newTokens.access_token;
        const newExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();
        await supabase.from('hubspot_tokens').update({ access_token, expires_at: newExpiresAt }).eq('id', 1);
    }
    return access_token;
}

// --- API Routes ---
app.get('/api/install', (req, res) => {
    const SCOPES = 'oauth crm.objects.companies.read crm.objects.contacts.read crm.objects.deals.read crm.schemas.companies.read crm.schemas.contacts.read forms marketing-email automation.workflows.read';
    const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=${SCOPES}`;
    res.redirect(authUrl);
});

app.get('/api/oauth-callback', async (req, res) => {
    const authCode = req.query.code;
    if (!authCode) return res.status(400).send('HubSpot authorization code not found.');
    try {
        const response = await fetch('https://api.hubapi.com/oauth/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, code: authCode }), });
        if (!response.ok) throw new Error(await response.text());
        const tokenData = await response.json();
        const { refresh_token, access_token, expires_in } = tokenData;
        const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
        
        const tokenInfoResponse = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${access_token}`);
        if (!tokenInfoResponse.ok) throw new Error('Failed to fetch HubSpot token info');
        const tokenInfo = await tokenInfoResponse.json();
        const portalId = tokenInfo.hub_id;

        await supabase.from('hubspot_tokens').upsert({ id: 1, refresh_token, access_token, expires_at: expiresAt }, { onConflict: 'id' });
        
        res.redirect(`${APP_BASE_URL}/?portalId=${portalId}`);
    } catch (error) {
        console.error(error);
        res.status(500).send(`<h1>Server Error</h1><p>${error.message}</p>`);
    }
});

// --- Placeholder for AI Readiness Logic ---
app.get('/api/ai-readiness-audit', async (req, res) => {
    // We will build the logic for this endpoint in the next phase.
    res.json({ message: "AI Readiness Audit endpoint is ready to be built." });
});


app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// CORRECTED: Explicitly set the host to '0.0.0.0' to be compatible with containerized environments.
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is live on port ${PORT}`);
});
