require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Environment Variables ---
const CLIENT_ID = process.env.HUBSPOT_CLIENT_ID;
const CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL; 
const REDIRECT_URI = `${APP_BASE_URL}/api/oauth-callback`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- HubSpot API Helper (Your Original, Proven Function) ---
async function getValidAccessToken(portalId) {
    const { data: installation, error } = await supabase.from('installations').select('refresh_token, access_token, expires_at').eq('hubspot_portal_id', portalId).single();
    if (error || !installation) throw new Error(`Could not find installation for portal ${portalId}. Please reinstall the app.`);
    let { refresh_token, access_token, expires_at } = installation;
    if (new Date() > new Date(expires_at)) {
        console.log(`Refreshing token for portal ${portalId}`);
        const response = await fetch('https://api.hubapi.com/oauth/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token }), });
        if (!response.ok) throw new Error('Failed to refresh access token');
        const newTokens = await response.json();
        access_token = newTokens.access_token;
        const newExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();
        await supabase.from('installations').update({ access_token, expires_at: newExpiresAt }).eq('hubspot_portal_id', portalId);
    }
    return access_token;
}

// --- API Routes (Your Original, Proven Routes) ---
app.get('/api/install', (req, res) => {
    const SCOPES = 'oauth crm.objects.companies.read crm.objects.contacts.read crm.objects.deals.read crm.schemas.companies.read crm.schemas.contacts.read forms marketing-email automation';
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
        const tokenInfoResponse = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${access_token}`);
        if (!tokenInfoResponse.ok) throw new Error('Failed to fetch HubSpot token info');
        const tokenInfo = await tokenInfoResponse.json();
        const hub_id = tokenInfo.hub_id;
        const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
        
        await supabase.from('installations').upsert({ hubspot_portal_id: hub_id, refresh_token, access_token, expires_at: expiresAt }, { onConflict: 'hubspot_portal_id' });
        
        res.redirect(`/?portalId=${hub_id}`);
    } catch (error) {
        console.error(error);
        res.status(500).send(`<h1>Server Error</h1><p>${error.message}</p>`);
    }
});

// --- NEW AI READINESS AUDIT ENDPOINT ---
app.get('/api/ai-readiness-audit', async (req, res) => {
    const portalId = req.header('X-HubSpot-Portal-Id');
    if (!portalId) return res.status(400).json({ message: 'HubSpot Portal ID is missing.' });
    try {
        const accessToken = await getValidAccessToken(portalId);
        const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

        const getAssociationRate = async () => {
            try {
                const totalSearch = { limit: 1 };
                const associatedSearch = { filterGroups: [{ filters: [{ propertyName: 'associatedcompanyid', operator: 'HAS_PROPERTY' }] }], limit: 1 };
                const [totalRes, associatedRes] = await Promise.all([
                    fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', headers, body: JSON.stringify(totalSearch) }),
                    fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', headers, body: JSON.stringify(associatedSearch) })
                ]);
                if (!totalRes.ok || !associatedRes.ok) return { metric: 'Contact Association Rate', value: 'API Error' };
                const totalData = await totalRes.json();
                const associatedData = await associatedRes.json();
                const rate = (totalData.total > 0) ? Math.round((associatedData.total / totalData.total) * 100) : 0;
                return { metric: 'Contact Association Rate', value: `${rate}%` };
            } catch (e) { return { metric: 'Contact Association Rate', value: 'Error' }; }
        };

        const getWorkflowCount = async () => {
            try {
                const response = await fetch('https://api.hubapi.com/automation/v3/workflows', { headers });
                if (!response.ok) return { metric: 'Active Workflow Count', value: 'API Error' };
                const data = await response.json();
                const activeWorkflows = (data.results || []).filter(wf => wf.enabled).length;
                return { metric: 'Active Workflow Count', value: activeWorkflows };
            } catch (e) { return { metric: 'Active Workflow Count', value: 'Error' }; }
        };

        const results = await Promise.all([ 
            getAssociationRate(), 
            getWorkflowCount()
        ]);
        res.json({ auditResults: results });
    } catch (error) {
        console.error("AI Readiness Audit Error:", error);
        res.status(500).json({ message: error.message });
    }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is live on port ${PORT}`);
});
