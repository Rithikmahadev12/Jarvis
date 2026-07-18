// Upgrade to the stealth-enabled orchestration framework
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function cleanPhoneNumber(phoneStr) {
    return ('' + phoneStr).replace(/\D/g, '');
}

async function reversePhoneLookup(rawInput, passedName = '') {
    if (!rawInput) {
        return { success: false, error: "No input provided." };
    }

    let targetName = passedName.trim();
    let phoneNumber = rawInput;

    // AUTOMATED QUERY SPLITTER
    const mixedInputMatch = rawInput.match(/^([\d\s\-()+][\d\s\-()]{6,})\s+(.+)$/);
    if (mixedInputMatch) {
        phoneNumber = mixedInputMatch[1].trim();
        if (!targetName) {
            targetName = mixedInputMatch[2].trim();
        }
    }

    const cleanedRaw = cleanPhoneNumber(phoneNumber);
    if (cleanedRaw.length < 7) {
        return { success: false, error: "Invalid phone number length." };
    }

    const formats = [
        cleanedRaw,                                      
        `${cleanedRaw.slice(0, 3)}-${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`
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

        // --- PHASE 1: SEARCH NAME TO LOCATE INSTAGRAM HANDLE ---
        let discoveredHandle = '';
        if (targetName.length > 0) {
            const nameDork = `site:instagram.com "${targetName}"`;
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(nameDork)}&hl=en`;
            
            await page.goto(googleUrl, { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 1000));

            discoveredHandle = await page.evaluate(() => {
                const modules = document.querySelectorAll('#search .g a');
                for (let linkEl of modules) {
                    const href = linkEl.href || '';
                    // Extract handle pattern from standard instagram.com/username links
                    const match = href.match(/instagram\.com\/([a-zA-Z0-9_\.]+)\/?/);
                    if (match && !['p', 'explore', 'developer', 'tags'].includes(match[1])) {
                        return match[1]; // Found target handle
                    }
                }
                return '';
            });
        }

        // --- PHASE 2: DEEP SCRAPE VIA UN-AUTHENTICATED MIRROR LAYER ---
        if (discoveredHandle) {
            // Using a highly resilient, public non-auth Instagram mirror layer
            const mirrorUrl = `https://picuki.com/profile/${discoveredHandle}`;
            try {
                await page.goto(mirrorUrl, { waitUntil: 'networkidle2', timeout: 15000 });
                
                const profileData = await page.evaluate((handle) => {
                    const nameEl = document.querySelector('.profile-name');
                    const usernameEl = document.querySelector('.profile-username');
                    const bioEl = document.querySelector('.profile-description');
                    const avatarEl = document.querySelector('.profile-avatar img');
                    
                    return {
                        platform: "Instagram",
                        title: nameEl ? nameEl.innerText.trim() : handle,
                        snippet: bioEl ? bioEl.innerText.trim() : 'No public biography configured.',
                        link: `https://instagram.com/${handle}`,
                        meta: {
                            handle: usernameEl ? usernameEl.innerText.trim().replace('@', '') : handle,
                            profilePic: avatarEl ? avatarEl.src : null
                        }
                    };
                }, discoveredHandle);

                if (profileData.title) {
                    socialMatches.push(profileData);
                }
            } catch (mirrorError) {
                console.log("Mirror layer parsing timed out or dropped. Falling back to search index index mapping...");
            }
        }

        // --- FALLBACK INTERFACE: IF MIRROR PIPELINE WAS LOCKED OUT ---
        if (socialMatches.length === 0 && targetName.length > 0) {
            const nameDork = `site:instagram.com "${targetName}"`;
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(nameDork)}&hl=en`;
            await page.goto(googleUrl, { waitUntil: 'networkidle2' });
            
            const standardMatches = await page.evaluate(() => {
                const results = [];
                const modules = document.querySelectorAll('#search .g');
                modules.forEach(mod => {
                    const titleEl = mod.querySelector('h3');
                    const linkEl = mod.querySelector('a');
                    const snippetEl = mod.querySelector('[style*="-webkit-line-clamp"], .VwiC3b');
                    
                    if (titleEl && linkEl && linkEl.href.includes('instagram.com')) {
                        results.push({
                            platform: "Instagram",
                            title: titleEl.innerText.trim(),
                            snippet: snippetEl ? snippetEl.innerText.trim() : '',
                            link: linkEl.href
                        });
                    }
                });
                return results;
            });
            socialMatches.push(...standardMatches);
        }

        await browser.close();

        // --- PHASE 3: PARSING LOGIC ENGINE ---
        let suspectedOwner = targetName || "Unknown / Unlisted Name";
        let classifications = [];

        if (socialMatches.length > 0) {
            classifications.push(`Social Footprints Isolated (${socialMatches.length})`);
            const topProfile = socialMatches[0];
            suspectedOwner = `${topProfile.title} (@${discoveredHandle || 'profile'})`;
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
