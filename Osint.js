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

    // Build standard US formats to force search engines to match text variations
    const formats = [
        cleanedRaw,                                      // 9714399447
        `${cleanedRaw.slice(0, 3)}-${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`, // 971-439-9447
        `(${cleanedRaw.slice(0, 3)}) ${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`, // (971) 439-9447
        `+1${cleanedRaw}`                                // +19714399447
    ];

    let browser;
    
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

        let socialMatches = [];
        let generalResults = [];

        // --- PHASE 1: TARGETED SOCIAL SPRINT ---
        // DuckDuckGo HTML breaks down on complex boolean strings. 
        // We isolate platforms explicitly and search the two most likely structural string formats.
        const targets = ['instagram.com', 'facebook.com', 'linkedin.com'];
        
        for (const site of targets) {
            // Target the clean hyphenated layout and the raw string layout
            const queryStr = `site:${site} ("${formats[1]}" OR "${formats[0]}")`;
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryStr)}`;
            
            await page.goto(searchUrl, { waitUntil: 'networkidle2' });
            
            // Artificial tiny delay to humanize behavior
            await new Promise(r => setTimeout(r, 600));

            const platformMatches = await page.evaluate((currentSite) => {
                const results = [];
                // CRITICAL FIX: DuckDuckGo HTML uses .links_main for result table containers
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
            
            // Optimization: If we hit a definitive social match early, we can proceed
            if (socialMatches.length > 2) break;
        }

        // --- PHASE 2: PUBLIC RECORD BLANKET SEARCH ---
        // Search using the standard structured phone format
        const generalSearchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${formats[1]}"`)}`;
        await page.goto(generalSearchUrl, { waitUntil: 'networkidle2' });

        generalResults = await page.evaluate(() => {
            const results = [];
            const rows = document.querySelectorAll('.links_main');
            rows.forEach(row => {
                const titleEl = row.querySelector('.result__title');
                const snippetEl = row.querySelector('.result__snippet');
                if (titleEl && snippetEl) {
                    results.push({
                        title: titleEl.innerText.trim(),
                        snippet: snippetEl.innerText.trim()
                    });
                }
            });
            return results;
        });

        await browser.close();

        // Fallback: If absolutely zero nodes are discovered, it's a structural anti-bot block
        if (generalResults.length === 0 && socialMatches.length === 0) {
            return {
                success: false,
                error: "Search pool exhausted. Engine anti-bot threshold triggered."
            };
        }

        // --- PHASE 3: EXTRACTION ENGINE ---
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

        // Try extracting pure handle/name from social headlines first
        for (const profile of socialMatches) {
            // Truncates generic title headers out of the text string
            let cleanedTitle = profile.title
                .replace(/(@\w+)/g, '$1') // Save handles
                .split(/[|•\-(]/)[0]
                .trim();
            
            if (cleanedTitle && !/^(instagram|facebook|linkedin|login|sign up)/i.test(cleanedTitle)) {
                suspectedOwner = `${cleanedTitle} (${profile.platform})`;
                break;
            }
        }

        // Public records regex parsing fallback
        if (suspectedOwner === "Unknown / Unlisted Name") {
            for (const item of generalResults) {
                const match = item.snippet.match(/(?:owned by|registered to|owner:)\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i);
                if (match && match[1]) {
                    suspectedOwner = match[1].trim();
                    break;
                }
            }
        }

        // Ultimate Headline Fallback
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
