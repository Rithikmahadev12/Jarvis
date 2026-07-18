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

    const formattedPhone = `${cleanedRaw.slice(0, 3)}-${cleanedRaw.slice(3, 6)}-${cleanedRaw.slice(6)}`;
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

        // --- PHASE 1: DIRECT INSTAGRAM LIVE NAME LOOKUP ---
        if (targetName.length > 0) {
            // Target the clean direct query endpoint directly
            const searchUrl = `https://picuki.com/search/?q=${encodeURIComponent(targetName)}`;
            
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            
            try {
                // FORCE THE ENGINE TO WAIT FOR DYNAMICALLY LOADED CARD COMPONENTS
                // Works for both '.profile-item' and layout blocks
                await page.waitForSelector('.profile-item, .profile-item-title, a[href*="/profile/"]', { timeout: 7000 });
                
                // Extraction execution inside the rendered tree
                const nameMatches = await page.evaluate((searchName) => {
                    const results = [];
                    
                    // Look through both modern dynamic container classes and legacy structures
                    const boxes = document.querySelectorAll('.profile-item, [class*="profile-item"]');
                    
                    boxes.forEach(box => {
                        const nameEl = box.querySelector('.profile-name, .profile-item-name, [class*="name"]');
                        const handleEl = box.querySelector('.profile-username, .profile-item-title, [class*="username"]');
                        const linkEl = box.querySelector('a');
                        
                        const profileName = nameEl ? nameEl.innerText.trim() : '';
                        let profileHandle = handleEl ? handleEl.innerText.trim().replace('@', '') : '';
                        
                        // Fallback parsing if selectors are clean but text layout is clustered
                        if (!profileHandle && linkEl && linkEl.href.includes('/profile/')) {
                            profileHandle = linkEl.href.split('/profile/')[1].split('/')[0];
                        }

                        if (profileName.toLowerCase().includes(searchName.toLowerCase()) || profileHandle.toLowerCase().includes(searchName.toLowerCase().replace(/\s+/g, ''))) {
                            results.push({
                                platform: "Instagram",
                                title: profileName || profileHandle,
                                snippet: `Discovered live match via targeted execution profile match.`,
                                link: `https://instagram.com/${profileHandle}`,
                                handle: profileHandle
                            });
                        }
                    });
                    
                    // Direct dynamic extraction block from standalone link nodes if the grid wrappers were compressed
                    if (results.length === 0) {
                        const backupLinks = document.querySelectorAll('a[href*="/profile/"]');
                        backupLinks.forEach(link => {
                            const handle = link.href.split('/profile/')[1].split('/')[0];
                            const text = link.innerText.trim();
                            if (handle.toLowerCase().includes(searchName.toLowerCase().replace(/\s+/g, '')) || text.toLowerCase().includes(searchName.toLowerCase())) {
                                results.push({
                                    platform: "Instagram",
                                    title: text || handle,
                                    snippet: `Discovered via secondary anchor parsing matrix.`,
                                    link: `https://instagram.com/${handle}`,
                                    handle: handle
                                });
                            }
                        });
                    }
                    
                    return results;
                }, targetName);

                if (nameMatches.length > 0) {
                    // Filter arrays down to unique entry pairs to avoid repeating handles
                    const uniqueMap = new Map();
                    nameMatches.forEach(item => uniqueMap.set(item.handle, item));
                    socialMatches.push(...Array.from(uniqueMap.values()));
                }
            } catch (timeoutErr) {
                console.log("Live directory UI took too long to draw elements. Invoking search engine layer...");
            }
        }

        // --- FALLBACK INTERFACE: FIREWALL DEFEAT LAYER ---
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
                    
                    if (titleEl && linkEl && linkEl.href.includes('instagram.com')) {
                        const href = linkEl.href;
                        const match = href.match(/instagram\.com\/([a-zA-Z0-9_\.]+)\/?/);
                        const handle = match ? match[1] : 'profile';
                        
                        if (!['p', 'explore', 'tags', 'developer'].includes(handle)) {
                            results.push({
                                platform: "Instagram",
                                title: titleEl.innerText.trim().split(/[|•\-()]/)[0].trim(),
                                snippet: "Extracted via historical index mapping.",
                                link: href,
                                handle: handle
                            });
                        }
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
            suspectedOwner = `${topProfile.title} (@${topProfile.handle})`;
        }

        return {
            success: true,
            number: formattedPhone,
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
