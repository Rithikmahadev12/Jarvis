// Upgrade to the stealth-enabled orchestration framework
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function cleanPhoneNumber(phoneStr) {
    // Strip everything except numbers to isolate the digits
    return ('' + phoneStr).replace(/\D/g, '');
}

async function reversePhoneLookup(rawInput, passedName = '') {
    if (!rawInput) {
        return { success: false, error: "No input provided." };
    }

    let targetName = passedName.trim();
    let phoneNumber = rawInput;

    // AUTOMATED QUERY SPLITTER
    // If a name was accidentally passed in the phone field (e.g. "971-462-6355 Rithik Mahadev")
    const mixedInputMatch = rawInput.match(/^([\d\s\-()+][\d\s\-()]{6,})\s+(.+)$/);
    if (mixedInputMatch) {
        phoneNumber = mixedInputMatch[1].trim();
        if (!targetName) {
            targetName = mixedInputMatch[2].trim(); // Extract the name automatically
        }
    }

    const cleanedRaw = cleanPhoneNumber(phoneNumber);
    if (cleanedRaw.length < 7) {
        return { success: false, error: "Invalid phone number length." };
    }

    const formats = [
        cleanedRaw,                                      
        `${cleanedRaw.slice(0, 3)}-${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`, 
        `(${cleanedRaw.slice(0, 3)}) ${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`
    ];

    let browser;
    let socialMatches = [];
    
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

        // --- PHASE 1: SEARCH BY EXTRACTED NAME ---
        if (targetName.length > 0) {
            const nameDork = `site:instagram.com "${targetName}"`;
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(nameDork)}&hl=en`;
            
            await page.goto(googleUrl, { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 1000));

            socialMatches = await page.evaluate(() => {
                const results = [];
                const modules = document.querySelectorAll('#search .g');
                
                modules.forEach(mod => {
                    const titleEl = mod.querySelector('h3');
                    const linkEl = mod.querySelector('a');
                    const snippetEl = mod.querySelector('[style*="-webkit-line-clamp"], .VwiC3b');
                    
                    if (titleEl && linkEl) {
                        const linkText = linkEl.href || '';
                        if (linkText.includes('instagram.com')) {
                            results.push({
                                platform: "Instagram",
                                title: titleEl.innerText.trim(),
                                snippet: snippetEl ? snippetEl.innerText.trim() : '',
                                link: linkText
                            });
                        }
                    }
                });
                return results;
            });
        }

        // --- PHASE 2: FALLBACK TO PHONE NUMBER DORK IF NO NAME MATCHES ---
        if (socialMatches.length === 0) {
            const googleDork = `(site:instagram.com OR site:facebook.com OR site:linkedin.com) "${formats[1]}"`;
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(googleDork)}&hl=en`;
            
            await page.goto(googleUrl, { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 1000));

            const phoneMatches = await page.evaluate(() => {
                const results = [];
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
            socialMatches.push(...phoneMatches);
        }

        await browser.close();

        // --- PHASE 3: PARSING LOGIC ENGINE ---
        let suspectedOwner = targetName || "Unknown / Unlisted Name";
        let classifications = [];

        if (socialMatches.length > 0) {
            classifications.push(`Social Footprints Isolated (${socialMatches.length})`);
            
            if (!targetName) {
                let cleanedTitle = socialMatches[0].title
                    .replace(/(@\w+)/g, '$1') 
                    .split(/[|•\-(]/)[0]
                    .trim();
                
                if (cleanedTitle && !/^(instagram|facebook|linkedin|login|sign up)/i.test(cleanedTitle)) {
                    suspectedOwner = `${cleanedTitle} (${socialMatches[0].platform})`;
                }
            }
        }

        return {
            success: true,
            number: `${formats[1]}`,
            owner: suspectedOwner,
            spamRisk: "Low",
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
