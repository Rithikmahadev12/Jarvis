// Upgrade to the stealth-enabled orchestration framework
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function cleanPhoneNumber(phoneStr) {
    return ('' + phoneStr).replace(/\D/g, '');
}

async function reversePhoneLookup(phoneNumber) {
    if (!phoneNumber) {
        return { success: false, error: "No phone number provided." };
    }

    const cleanedRaw = cleanPhoneNumber(phoneNumber);
    if (cleanedRaw.length < 7) {
        return { success: false, error: "Invalid phone number length." };
    }

    const formats = [
        cleanedRaw,                                      
        `${cleanedRaw.slice(0, 3)}-${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`, 
        `(${cleanedRaw.slice(0, 3)}) ${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`, 
        `+1${cleanedRaw}`                                
    ];

    let browser;
    let socialMatches = [];
    let generalResults = [];
    
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,800'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        // --- ENGINE 1: TRACK VIA DUCKDUCKGO INDEX ---
        try {
            const targets = ['instagram.com', 'facebook.com', 'linkedin.com'];
            for (const site of targets) {
                const queryStr = `site:${site} ("${formats[1]}" OR "${formats[0]}")`;
                const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryStr)}`;
                
                await page.goto(searchUrl, { waitUntil: 'networkidle2' });
                await new Promise(r => setTimeout(r, 600));

                const platformMatches = await page.evaluate((currentSite) => {
                    const results = [];
                    const rows = document.querySelectorAll('.links_main');
                    rows.forEach(row => {
                        const titleEl = row.querySelector('.result__title');
                        const snippetEl = row.querySelector('.result__snippet');
                        const linkEl = row.querySelector('.result__url');
                        
                        if (titleEl && snippetEl) {
                            let platform = "Social Profile";
                            if (currentSite.includes('instagram')) platform = "Instagram";
                            else if (currentSite.includes('facebook')) platform = "Facebook";
                            else if (currentSite.includes('linkedin')) platform = "LinkedIn";

                            results.push({
                                platform: platform,
                                title: titleEl.innerText.trim(),
                                snippet: snippetEl.innerText.trim(),
                                link: linkEl ? linkEl.innerText.trim() : ''
                            });
                        }
                    });
                    return results;
                }, site);
                socialMatches.push(...platformMatches);
            }

            const generalSearchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${formats[1]}"`)}`;
            await page.goto(generalSearchUrl, { waitUntil: 'networkidle2' });
            generalResults = await page.evaluate(() => {
                const results = [];
                const rows = document.querySelectorAll('.links_main');
                rows.forEach(row => {
                    const titleEl = row.querySelector('.result__title');
                    const snippetEl = row.querySelector('.result__snippet');
                    if (titleEl && snippetEl) {
                        results.push({ title: titleEl.innerText.trim(), snippet: snippetEl.innerText.trim() });
                    }
                });
                return results;
            });
        } catch (e) {
            console.log("DuckDuckGo engine throttled. Auto-failing over to alternative index...");
        }

        // --- ENGINE 2: AUTO-FAILOVER NET TO GOOGLE ENGINE ---
        // Runs cleanly if DuckDuckGo returned an empty payload due to anti-bot challenges.
        if (socialMatches.length === 0 && generalResults.length === 0) {
            const googleDork = `(site:instagram.com OR site:facebook.com OR site:linkedin.com) "${formats[1]}"`;
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(googleDork)}&hl=en`;
            
            await page.goto(googleUrl, { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 1000));

            const googleMatches = await page.evaluate(() => {
                const results = [];
                // Target standard modern Google DOM layout wrapper modules
                const modules = document.querySelectorAll('#search .g');
                
                modules.forEach(mod => {
                    const titleEl = mod.querySelector('h3');
                    const linkEl = mod.querySelector('a');
                    const snippetEl = mod.querySelector('[style*="-webkit-line-clamp"], .VwiC3b');
                    
                    if (titleEl && linkEl) {
                        const linkText = linkEl.href || '';
                        let platform = "Social Profile";
                        if (linkText.includes('instagram.com')) platform = "Instagram";
                        else if (linkText.includes('facebook.com')) platform = "Facebook";
                        else if (linkText.includes('linkedin.com')) platform = "LinkedIn";

                        results.push({
                            platform: platform,
                            title: titleEl.innerText.trim(),
                            snippet: snippetEl ? snippetEl.innerText.trim() : '',
                            link: linkText
                        });
                    }
                });
                return results;
            });
            socialMatches.push(...googleMatches);
        }

        await browser.close();

        // If BOTH engine pipelines return empty arrays, the network gateway IP is dropped out completely.
        if (generalResults.length === 0 && socialMatches.length === 0) {
            return {
                success: true,
                number: phoneNumber,
                owner: "Unknown / Unlisted Name",
                details: "Search engines did not yield matches under current network session parameters.",
                spamRisk: "Low",
                socialMatches: []
            };
        }

        // --- PHASE 3: PARSING LOGIC ENGINE ---
        let classifications = [];
        if (socialMatches.length > 0) {
            classifications.push(`Social Footprints Isolated (${socialMatches.length})`);
        }

        let combinedText = [...generalResults, ...socialMatches].map(r => `${r.title} ${r.snippet}`).join(' ').toLowerCase();
        let suspectedOwner = "Unknown / Unlisted Name";
        let riskScore = "Low";

        if (/\b(scam|telemarketer|spam|fraud|robocall)\b/.test(combinedText)) {
            riskScore = "High";
            classifications.push("Reported Spam Active");
        }

        for (const profile of socialMatches) {
            let cleanedTitle = profile.title
                .replace(/(@\w+)/g, '$1') 
                .split(/[|•\-(]/)[0]
                .trim();
            
            if (cleanedTitle && !/^(instagram|facebook|linkedin|login|sign up)/i.test(cleanedTitle)) {
                suspectedOwner = `${cleanedTitle} (${profile.platform})`;
                break;
            }
        }

        if (suspectedOwner === "Unknown / Unlisted Name") {
            for (const item of generalResults) {
                const match = item.snippet.match(/(?:owned by|registered to|owner:)\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i);
                if (match && match[1]) {
                    suspectedOwner = match[1].trim();
                    break;
                }
            }
        }

        if (suspectedOwner === "Unknown / Unlisted Name" && generalResults.length > 0) {
            const topTitle = generalResults[0].title.split(/[|•\-]/)[0].trim();
            if (topTitle.length > 3) suspectedOwner = topTitle;
        }

        return {
            success: true,
            number: phoneNumber,
            owner: suspectedOwner,
            spamRisk: riskScore,
            tags: classifications.length > 0 ? classifications : ["Personal Line"],
            socialMatches: socialMatches
        };

    } catch (error) {
        if (browser) await browser.close();
        console.error("OSINT Pipeline Exception:", error);
        return { success: false, error: "Scraping pipeline execution failure." };
    }
}

module.exports = { reversePhoneLookup };
