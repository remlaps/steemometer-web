// ============================================================
// Steemometer - Web Version 0.0.4
// Ported from Java Steemometer by Steve Palmer
// ============================================================

// --- Constants ---
const WIDTH = 400;
const HEIGHT = 300;
const CHARTTOP = 40;
const VAAS_WIDTH = 360;
const VAAS_HEIGHT = 70;
const UPDATE_INTERVAL = 1000; // ms
const LABEL_COUNT = 9;
const BLOCKS_PER_MINUTE = 20;
const MAX_SPEED = 60;
const MAX_FAIL = 3;
const VAAS_INTERVAL = 30;
const MAX_BLOCKS_TO_SAVE = 100;
const HALFLIFE_BLOCKS = 1200;
const MAXLIFE_BLOCKS = 28800;
const MINREP_FOR_BEN_DISPLAY = 45.0;
const MED_FOLLOWER_REP_FOR_BEN_DISPLAY = 35.0;
const MIN_FOLLOWERS_FOR_BEN_DISPLAY = 20;
const NOTIFY_LIFE_TIME = 1800;
const MIN_STEEM_XFER = 17370;
const MIN_SBD_XFER = 5790;
const MIN_POWERUP = 5790;
const MIN_POWERDOWN = 10000000;
const MIN_WITHDRAWAL = 2500000.0;

// --- API Servers ---
const API_SERVERS = [
    "https://api.campingclub.me",
    "https://api.dhakawitness.com",
    "https://api.justyy.com",
    "https://api.moecki.online",
    "https://api.steememory.com",
    "https://api.steemit.com",
    "https://api.steemitdev.com",
    "https://api.steemyy.com",
    "https://steem.senior.workers.dev",
    "https://steemapi.boylikegirl.club",
    "https://steemd.steemworld.org"
];

const WEB_SERVERS = [
    "https://steemit.com",
    "https://steemit.moecki.online",
    "https://steemit.steemapps.com",
    "https://steemitdev.com",
    "https://steempro.com"
];

// --- State ---
let state = {
    lastBlockChecked: 0,
    vaasLastBlockChecked: 0,
    numBlocks: 0,
    filter: "all",
    opsByName: {},       // current block counts
    opsByNameCum: {},    // cumulative
    opsByNameMax: {},    // max per block
    opsByNameAvg: {},    // average
    opsByNameCount: {},
    displayMax: 0,
    displayAvg: 0,
    lastPollValid: false,
    failCount: 0,
    apiURL: null,
    urlLeft: "https://steemit.com",
    webUrl: "https://steemit.com/",
    webPath: null,
    prevBlock: 0,
    currBlock: 0,
    paused: false,
    changePost: true,
    voteIndexValue: 0,
    authorObj: null
};

// Data queues for graph (last 100 values per filter type)
let dataQueues = {
    "all": [],
    "comment": [],
    "vote": [],
    "transfer": [],
    "custom_json": []
};
for (const key in dataQueues) {
    for (let i = 0; i < 100; i++) dataQueues[key].push(0);
}

// Block queue for rolling average
let blockQueue = [];
let thisOpCount = {};

// VAAS data stores
let benPostList = [];       // null beneficiary posts
let promoTransferList = []; // null transfers with memos

// Notification state
let lastNotifiedTrxId = "0000000000000000000000000000000000000000";
let lastNotifiedBlock = 0;
let notificationTimer = null;

// Scrolling animation handles
let scrollAnimFrame = null;
let scrollPromoAnimFrame = null;

// ============================================================
// JSON-RPC Helpers
// ============================================================

async function jsonRpcCall(url, method, params, maxRetries = 2) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: method,
                    params: params,
                    id: 1
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            return data;
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                console.warn(`Attempt ${attempt} failed for ${method}, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }
    
    console.error(`JSON-RPC call failed for ${method} after ${maxRetries} attempts:`, lastError.message);
    throw lastError;
}

async function getLastIrreversibleBlock(url) {
    const data = await jsonRpcCall(url, "condenser_api.get_dynamic_global_properties", []);
    return data.result.last_irreversible_block_num;
}

async function getOpsInBlock(url, blockNum) {
    const data = await jsonRpcCall(url, "condenser_api.get_ops_in_block", [blockNum, false]);
    return data.result || [];
}

// ============================================================
// Author Info Helpers
// ============================================================

async function retrieveReputation(author, apiUrl) {
    try {
        const data = await jsonRpcCall(apiUrl, "condenser_api.get_accounts", [[author]]);
        if (data.result && data.result.length > 0) {
            const rep = data.result[0].reputation;
            if (rep === 0) return 25;
            const neg = rep < 0;
            const repLog = Math.log10(Math.abs(rep));
            let level = Math.max(repLog - 9, 0);
            if (level < 0) level = 0;
            level = neg ? -level : level;
            return Math.round(level * 9 + 25);
        }
    } catch (e) {
        console.error("Error fetching reputation:", e);
    }
    return 25;
}

async function retrieveFollowerCount(author, apiUrl) {
    try {
        const data = await jsonRpcCall(apiUrl, "condenser_api.get_follow_count", [author]);
        return data.result ? data.result.follower_count : 0;
    } catch (e) {
        console.error("Error fetching follower count:", e);
        return 0;
    }
}

async function calcFollowerMedianAndCount(apiUrl, author) {
    try {
        const data = await jsonRpcCall(apiUrl, "condenser_api.get_followers", [author, "", "blog", 100]);
        const followers = data.result || [];
        if (followers.length === 0) return [0, 0];

        const followerNames = followers.map(f => f.follower);
        const accountsData = await jsonRpcCall(apiUrl, "condenser_api.get_accounts", [followerNames]);
        const accounts = accountsData.result || [];

        const reps = accounts.map(acc => {
            const rep = acc.reputation;
            if (rep === 0) return 25;
            const neg = rep < 0;
            const repLog = Math.log10(Math.abs(rep));
            let level = Math.max(repLog - 9, 0);
            if (level < 0) level = 0;
            level = neg ? -level : level;
            return Math.round(level * 9 + 25);
        });

        reps.sort((a, b) => a - b);
        const mid = Math.floor(reps.length / 2);
        const median = reps.length % 2 === 0 ? (reps[mid - 1] + reps[mid]) / 2 : reps[mid];

        return [median, followers.length];
    } catch (e) {
        console.error("Error calculating follower median:", e);
        return [0, followers ? followers.length : 0];
    }
}

// ============================================================
// Post Info
// ============================================================

async function retrievePostInfo(post, apiUrl) {
    try {
        const data = await jsonRpcCall(apiUrl, "condenser_api.get_content", [post.author, post.permlink]);
        if (data.result && data.result.id !== 0) {
            let title = data.result.title || "(no title)";
            post.pendingPayout = parseFloat(data.result.pending_payout_value) || 0;
            post.netVotes = data.result.net_votes || 0;
            post.steemURL = "/@" + post.author + "/" + post.permlink;

            // If this is a reply (comment), fetch the parent post title
            const parentAuthor = data.result.parent_author;
            const parentPermlink = data.result.parent_permlink;
            if (parentAuthor && parentPermlink && parentAuthor !== "" && title === "(no title)") {
                try {
                    const parentData = await jsonRpcCall(apiUrl, "condenser_api.get_content", [parentAuthor, parentPermlink]);
                    if (parentData.result && parentData.result.id !== 0 && parentData.result.title) {
                        title = `Reply to: ${parentData.result.title}`;
                    }
                } catch (e) {
                    console.error("Error fetching parent post info:", e);
                }
            }

            post.title = title;
            return title;
        }
    } catch (e) {
        console.error("Error retrieving post info:", e);
    }
    return null;
}

// ============================================================
// Steem Price
// ============================================================

async function calculateSteemPerSbd(apiUrl) {
    try {
        const data = await jsonRpcCall(apiUrl, "condenser_api.get_feed_history", []);
        if (data.result && data.result.current_median_history) {
            const base = parseFloat(data.result.current_median_history.base);
            const quote = parseFloat(data.result.current_median_history.quote);
            return base / quote;
        }
    } catch (e) {
        console.error("Error fetching feed history:", e);
    }
    return 1;
}

// ============================================================
// Beneficiary Weight Extraction
// ============================================================

function getWeightForAccount(jsonStr, accountName) {
    try {
        const jsonFields = JSON.parse(jsonStr);
        for (let i = 0; i < jsonFields.length; i++) {
            const oneJsonField = jsonFields[i];
            if (oneJsonField.length === 2) {
                const oneFieldData = oneJsonField[1];
                const beneficiaries = oneFieldData.beneficiaries;
                for (let j = 0; j < beneficiaries.length; j++) {
                    const beneficiary = beneficiaries[j];
                    if (beneficiary.account === accountName) {
                        return beneficiary.weight;
                    }
                }
            }
        }
    } catch (e) {
        console.error("Error parsing beneficiaries:", e);
    }
    return -1;
}

// ============================================================
// Core Logic: Count Ops in Block
// ============================================================

async function countOpsInBlock(blockNum, apiUrl) {
    state.lastPollValid = false;
    thisOpCount = {};
    const blockCounts = {};

    try {
        const opsArray = await getOpsInBlock(apiUrl, blockNum);

        for (let i = 0; i < opsArray.length; i++) {
            const operationJson = opsArray[i];
            const opArray = operationJson.op;
            const transactionId = operationJson.trx_id;
            const opName = opArray[0];
            const opData = opArray[1];

            if (!thisOpCount[opName]) thisOpCount[opName] = 0;
            thisOpCount[opName]++;

            if (!blockCounts[opName]) blockCounts[opName] = 0;
            blockCounts[opName]++;

            if (!state.opsByNameCount[opName]) state.opsByNameCount[opName] = 0;
            state.opsByNameCount[opName]++;

            if (!blockCounts["all"]) blockCounts["all"] = 0;
            blockCounts["all"]++;

            processNotifications(opArray, blockNum, transactionId);
        }

        for (const key in blockCounts) {
            if (!state.opsByNameCum[key]) state.opsByNameCum[key] = 0;
            state.opsByNameCum[key] += blockCounts[key];
        }

        for (const key in blockCounts) {
            if (!state.opsByNameMax[key] || blockCounts[key] > state.opsByNameMax[key]) {
                state.opsByNameMax[key] = blockCounts[key];
            }
        }

        state.lastBlockChecked = blockNum;
        state.numBlocks++;
        state.lastPollValid = true;

        for (const key in state.opsByNameCum) {
            state.opsByNameAvg[key] = state.opsByNameCum[key] / state.numBlocks;
        }

        blockQueue.push({...thisOpCount});
        thisOpCount = {};

        if (blockQueue.length > MAX_BLOCKS_TO_SAVE) {
            blockQueue.shift();
        }

        const count = blockQueue.length;
        const startIndex = Math.max(0, count - 20);
        const totalSums = {};
        let cumTotal = 0;

        for (let idx = startIndex; idx < count; idx++) {
            const entry = blockQueue[idx];
            for (const key in entry) {
                if (!totalSums[key]) totalSums[key] = 0;
                totalSums[key] += entry[key];
                cumTotal += entry[key];
            }
        }

        const trackTypes = ['all', 'comment', 'vote', 'transfer', 'custom_json'];
        trackTypes.forEach(t => {
            if (t === 'all') {
                state.opsByName['all'] = Math.round(cumTotal * 20 / Math.min(count, 20));
            } else {
                state.opsByName[t] = Math.round((totalSums[t] || 0) * 20 / Math.min(count, 20));
            }
        });
        for (const key in totalSums) {
            if (!trackTypes.includes(key)) {
                state.opsByName[key] = Math.round(totalSums[key] * 20 / Math.min(count, 20));
            }
        }

        return 0;
    } catch (e) {
        console.error("Error counting ops in block:", e);
        state.lastPollValid = false;
        return -1;
    }
}

// ============================================================
// VAAS Processing Loop
// ============================================================

async function processVaasInBlock(blockNum, apiUrl) {
    try {
        const opsArray = await getOpsInBlock(apiUrl, blockNum);

        for (let i = 0; i < opsArray.length; i++) {
            const operationJson = opsArray[i];
            const opArray = operationJson.op;
            const opName = opArray[0];
            const opData = opArray[1];

            if (opName === "comment_options") {
                for (const key in opData) {
                    if (key === "extensions") {
                        const nullWeight = getWeightForAccount(JSON.stringify(opData[key]), "null");
                        if (nullWeight !== -1) {
                            await saveNullPost(opData, nullWeight, blockNum, apiUrl);
                        }
                    }
                }
            }

            if (opName === "transfer") {
                await saveNullXfer(opData, blockNum, apiUrl);
            }
        }
    } catch (e) {
        console.error("Error processing VAAS in block:", e);
    }
}

async function vaasLoop() {
    if (state.paused) {
        setTimeout(vaasLoop, 1000);
        return;
    }

    if (state.lastBlockChecked === 0) {
        setTimeout(vaasLoop, 1000);
        return;
    }

    if (state.vaasLastBlockChecked === 0) {
        state.vaasLastBlockChecked = state.lastBlockChecked - MAXLIFE_BLOCKS;
    }

    if (state.vaasLastBlockChecked < state.lastBlockChecked) {
        const blockToProcess = state.vaasLastBlockChecked + 1;
        await processVaasInBlock(blockToProcess, state.apiURL);
        state.vaasLastBlockChecked = blockToProcess;
        setTimeout(vaasLoop, 10);
    } else {
        setTimeout(vaasLoop, 1000);
    }
}

// ============================================================
// Save Null Beneficiary Post
// ============================================================

async function saveNullPost(opData, nullWeight, blockNum, apiUrl) {
    try {
        const commentAuthor = opData.author;
        const permLink = opData.permlink;

        const post = {
            author: commentAuthor,
            permlink: permLink,
            nullBenWeight: nullWeight,
            blockNum: blockNum,
            title: null,
            pendingPayout: 0,
            netVotes: 0,
            authorReputation: 0,
            authorFollowers: 0,
            medianRepOfFollowers: 0,
            steemURL: null
        };

        const tmpRep = await retrieveReputation(commentAuthor, apiUrl);
        const tmpFollowerCount = await retrieveFollowerCount(commentAuthor, apiUrl);
        const followerInfo = await calcFollowerMedianAndCount(apiUrl, commentAuthor);
        const tmpMedianFollowerRep = followerInfo[0];

        post.authorReputation = tmpRep;
        post.authorFollowers = tmpFollowerCount;
        post.medianRepOfFollowers = tmpMedianFollowerRep;

        if (tmpRep > MINREP_FOR_BEN_DISPLAY && tmpFollowerCount > MIN_FOLLOWERS_FOR_BEN_DISPLAY
            && tmpMedianFollowerRep > MED_FOLLOWER_REP_FOR_BEN_DISPLAY) {
            benPostList.push(post);
            console.log("Added beneficiary post:", commentAuthor, permLink);
        } else {
            console.log("Not adding due to low reputation/followers:", commentAuthor);
        }
    } catch (e) {
        console.error("Error saving null post:", e);
    }
}

// ============================================================
// Save Null Transfer (Vanity Messages)
// ============================================================

async function saveNullXfer(opData, blockNum, apiUrl) {
    try {
        const amountParts = opData.amount.split(" ");
        const xferAmount = parseFloat(amountParts[0]);
        const xferType = amountParts[1];
        const xferMemo = opData.memo || "";
        const xferFrom = opData.from;
        const xferTo = opData.to;

        const medianSteemPerSbd = await calculateSteemPerSbd(apiUrl);

        const transferInfo = {
            xferFrom: xferFrom,
            xferTo: xferTo,
            xferMemo: xferMemo,
            xferType: xferType,
            xferAmount: xferAmount,
            medianSteemPerSbd: medianSteemPerSbd,
            blockNum: blockNum,
            xferNormal: xferType === "SBD" ? xferAmount * medianSteemPerSbd : xferAmount
        };

        if (xferTo === "null" && xferMemo.trim() !== "") {
            console.log("Null transfer with memo from:", xferFrom);
            promoTransferList.push(transferInfo);
        }
    } catch (e) {
        console.error("Error saving null transfer:", e);
    }
}

// ============================================================
// Transaction Notifications
// ============================================================

function processNotifications(opArray, blockNum, transactionId) {
    const opName = opArray[0];
    const opData = opArray[1];

    let notify = false;
    let notifyMsg = "";

    if (opName === "transfer") {
        const amount = parseFloat(opData.amount.split(" ")[0]);
        const type = opData.amount.split(" ")[1];
        if (type === "STEEM" && amount >= MIN_STEEM_XFER) {
            notify = true;
            notifyMsg = `Large STEEM transfer: ${amount} STEEM from ${opData.from}`;
        } else if (type === "SBD" && amount >= MIN_SBD_XFER) {
            notify = true;
            notifyMsg = `Large SBD transfer: ${amount} SBD from ${opData.from}`;
        }
    } else if (opName === "transfer_to_vesting") {
        const amount = parseFloat(opData.amount.split(" ")[0]);
        if (amount >= MIN_POWERUP) {
            notify = true;
            notifyMsg = `Power Up: ${amount} STEEM from ${opData.from}`;
        }
    } else if (opName === "withdraw_vesting") {
        const amount = parseFloat(opData.vesting_shares.split(" ")[0]);
        if (amount >= MIN_WITHDRAWAL) {
            notify = true;
            notifyMsg = `Power Down: ${amount} VESTS from ${opData.account}`;
        }
    }

    if (notify) {
        showNotification(notifyMsg, transactionId, blockNum);
    }
}

function showNotification(msg, trxId, blockNum) {
    lastNotifiedTrxId = trxId;
    lastNotifiedBlock = blockNum;

    const overlay = document.getElementById('notificationOverlay');
    overlay.textContent = msg;
    overlay.style.display = 'block';
    overlay.onclick = () => {
        const url = trxId !== "0000000000000000000000000000000000000000"
            ? `https://steemdb.io/tx/${trxId}`
            : `https://steemdb.io/block/${blockNum}`;
        window.open(url, '_blank');
    };

    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
        overlay.style.display = 'none';
    }, NOTIFY_LIFE_TIME * 3);
}

// ============================================================
// Trim old posts from lists
// ============================================================

function trimPosts(currentBlock) {
    benPostList = benPostList.filter(p => (currentBlock - p.blockNum) < MAXLIFE_BLOCKS);
}

function trimMemos(currentBlock) {
    promoTransferList = promoTransferList.filter(m => (currentBlock - m.blockNum) < MAXLIFE_BLOCKS);
}

function getRandomPost(currentBlock) {
    const valid = benPostList.filter(p => (currentBlock - p.blockNum) < MAXLIFE_BLOCKS);
    if (valid.length === 0) return null;
    return valid[Math.floor(Math.random() * valid.length)];
}

function getRandomMemo(currentBlock) {
    const valid = promoTransferList.filter(m => (currentBlock - m.blockNum) < MAXLIFE_BLOCKS);
    if (valid.length === 0) return null;
    return valid[Math.floor(Math.random() * valid.length)];
}

function getTotalMemoPromos(sender, message) {
    let total = 0;
    for (const m of promoTransferList) {
        if (m.xferFrom === sender && m.xferMemo === message) {
            total += m.xferNormal;
        }
    }
    return total;
}

// ============================================================
// Gauge Drawing
// ============================================================

function drawGauge(speed) {
    const canvas = document.getElementById('gaugeCanvas');
    const ctx = canvas.getContext('2d');

    // Use the canvas's actual pixel size instead of a hardcoded "440".
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Scale factor relative to the original 440px-tall design, so all the
    // offsets below stay proportional no matter what size the canvas is.
    const scale = h / 440;

    const GAUGE_CX = w / 2;
    const EXT_CY = h / 2 + 20 * scale;
    const EXT_RX = w / 2 - 20;
    const EXT_RY = h / 2;
    const INT_CY = EXT_CY - 70 * scale;
    const INT_RX = 105;
    const INT_RY = 85 * scale;
    const LBL_CY = h / 2;
    const LBL_R = w / 2 - 50;
    const NDL_CY = EXT_CY - 2 * scale;

    // ---- Exterior dome (flat side down) ----
    ctx.beginPath();
    ctx.ellipse(GAUGE_CX, EXT_CY, EXT_RX, EXT_RY, 0, 0, Math.PI, true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(245, 245, 245, 0.75)';
    ctx.fill();
    ctx.strokeStyle = 'royalblue';
    ctx.lineWidth = 2;
    ctx.stroke();

    // ---- Interior decorative panel ----
    // A 250° arc centered on the TOP of the ellipse, leaving a 110° gap
    // centered at the bottom. ctx.closePath() draws the straight chord
    // across that gap, giving the rounded-top / flat-bottom panel shape
    // (matches the box behind the "# Blocks / Last Block / ..." text).
    const gapHalfDeg = 55; // half of the 110° bottom gap
    const intStart = (90 + gapHalfDeg) * Math.PI / 180;
    const intEnd = (90 - gapHalfDeg + 360) * Math.PI / 180;
    ctx.beginPath();
    ctx.ellipse(GAUGE_CX, INT_CY, INT_RX, INT_RY, 0, intStart, intEnd, false);
    ctx.closePath();
    ctx.fillStyle = 'rgba(65, 105, 225, 0.20)';
    ctx.fill();
    ctx.strokeStyle = 'navy';
    ctx.lineWidth = 1;
    ctx.stroke();

    // ---- Speed labels ----
    ctx.font = 'bold 12px Verdana';
    ctx.fillStyle = 'navy';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= LABEL_COUNT; i++) {
        const value = Math.floor(i * MAX_SPEED * BLOCKS_PER_MINUTE / LABEL_COUNT);
        const angleDeg = 180 - i * (180.0 / LABEL_COUNT);
        const rad = angleDeg * Math.PI / 180;
        const x = GAUGE_CX + LBL_R * Math.cos(rad);
        const y = LBL_CY - LBL_R * Math.sin(rad);
        ctx.fillText(value.toString(), x, y);
    }

    // ---- Needle ----
    const needleAngle = speed < MAX_SPEED * BLOCKS_PER_MINUTE
        ? (speed / (BLOCKS_PER_MINUTE * MAX_SPEED)) * 180.0
        : 180;
    const needleRad = (180 - needleAngle) * Math.PI / 180;
    const ndlEndX = GAUGE_CX + LBL_R * Math.cos(needleRad);
    const ndlEndY = LBL_CY - LBL_R * Math.sin(needleRad) + 5;

    ctx.beginPath();
    ctx.moveTo(GAUGE_CX, NDL_CY);
    ctx.lineTo(ndlEndX, ndlEndY);
    ctx.strokeStyle = 'goldenrod';
    ctx.lineWidth = 5;
    ctx.stroke();
}

// ============================================================
// Graph Drawing
// ============================================================

function drawGraph() {
    const canvas = document.getElementById('graphCanvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const padding = { top: 20, right: 20, bottom: 30, left: 40 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;
    
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'whitesmoke';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'royalblue';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, w, h);

    ctx.fillStyle = '#333';
    ctx.font = '12px Verdana';
    ctx.textAlign = 'center';
    ctx.fillText('Operations per minute (20 block avg.)', w / 2, h - 5);

    ctx.fillStyle = '#666';
    ctx.font = '10px Verdana';
    ctx.textAlign = 'right';
    const maxY = MAX_SPEED * BLOCKS_PER_MINUTE;
    for (let y = 0; y <= maxY; y += 10 * BLOCKS_PER_MINUTE) {
        const yPos = padding.top + plotH - (y / maxY) * plotH;
        ctx.fillText(y.toString(), padding.left - 5, yPos + 3);
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(padding.left, yPos);
        ctx.lineTo(w - padding.right, yPos);
        ctx.stroke();
    }

    const activeQueue = dataQueues[state.filter] || [];
    if (activeQueue.length < 2) return;

    ctx.strokeStyle = 'royalblue';
    ctx.lineWidth = 2;
    ctx.beginPath();

    const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
    gradient.addColorStop(0, 'rgba(65, 105, 225, 0.3)');
    gradient.addColorStop(1, 'rgba(65, 105, 225, 0.05)');

    for (let i = 0; i < activeQueue.length; i++) {
        const x = padding.left + (i / (activeQueue.length - 1)) * plotW;
        const y = padding.top + plotH - (activeQueue[i] / maxY) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }

    ctx.stroke();

    const lastX = padding.left + plotW;
    const bottomY = padding.top + plotH;
    ctx.lineTo(lastX, bottomY);
    ctx.lineTo(padding.left, bottomY);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
}

// ============================================================
// Scrolling Text Animation
// ============================================================

function startScrolling(elementId, text) {
    const el = document.getElementById(elementId);
    if (!el) return;

    if (el._scrollListener) {
        el.removeEventListener('transitionend', el._scrollListener);
    }

    el.textContent = text;
    
    // Constant speed in pixels per second
    const speed = 50; 

    function loop() {
        el.style.transition = 'none';
        // Start from right edge (off-screen)
        el.style.transform = `translateX(${VAAS_WIDTH}px)`;
        
        // Force a reflow to ensure the browser applies the 'none' transition
        // before we re-enable it, preventing the animation from being skipped.
        void el.offsetWidth;
        
        const distance = VAAS_WIDTH + el.offsetWidth;
        const duration = distance / speed;
        
        el.style.transition = `transform ${duration}s linear`;
        // Scroll completely off the left side
        el.style.transform = `translateX(-${el.offsetWidth}px)`;
    }

    el._scrollListener = loop;
    el.addEventListener('transitionend', loop);

    // Start from right edge (off-screen), ready to scroll in
    el.style.transition = 'none';
    el.style.transform = `translateX(${VAAS_WIDTH}px)`;
    
    // Force a reflow to ensure the initial position is applied
    void el.offsetWidth;
    
    // Start the animation after a brief delay
    setTimeout(() => {
        const distance = VAAS_WIDTH + el.offsetWidth;
        const duration = distance / speed;
        
        el.style.transition = `transform ${duration}s linear`;
        el.style.transform = `translateX(-${el.offsetWidth}px)`;
    }, 20);
}

function stopScrolling(elementId) {
    const el = document.getElementById(elementId);
    if (el) {
        if (el._scrollListener) {
            el.removeEventListener('transitionend', el._scrollListener);
            el._scrollListener = null;
        }
        el.style.transition = 'none';
        el.style.transform = 'translateX(0)';
    }
}

// ============================================================
// Update Dashboard Labels
// ============================================================

function updateDashLabels() {
    document.getElementById('blockCountLabel').textContent = `# Blocks: ${state.numBlocks}`;
    document.getElementById('digitalLBC').textContent = `Last Block: ${state.lastBlockChecked}`;
    document.getElementById('digitalDisplay').textContent = `Operations per Minute: ${state.opsByName[state.filter] || 0}`;
    document.getElementById('digitalDisplayMax').textContent = `Maximum Value: ${BLOCKS_PER_MINUTE * (state.opsByNameMax[state.filter] || 0)}`;
    document.getElementById('digitalDisplayAvg').textContent = `Average Value: ${(BLOCKS_PER_MINUTE * (state.opsByNameAvg[state.filter] || 0)).toFixed(0)}`;
}

// ============================================================
// VAAS Display Update
// ============================================================

async function updateVAAS() {
    if (state.numBlocks % VAAS_INTERVAL !== 1) {
        if (state.numBlocks % VAAS_INTERVAL === 2) {
            state.changePost = true;
        }
        return;
    }

    if (!state.changePost) return;
    state.changePost = false;

    trimPosts(state.lastBlockChecked);
    trimMemos(state.lastBlockChecked);

    const numTypes = 3;
    let vaasType = Math.floor(Math.random() * numTypes);

    for (let lcv = 0; lcv < numTypes; lcv++) {
        const chkVaasType = (vaasType + lcv) % numTypes;
        if (chkVaasType === 0 && benPostList.length > 0) {
            vaasType = 0;
            break;
        } else if ((chkVaasType === 1 || chkVaasType === 2) && promoTransferList.length > 0) {
            vaasType = chkVaasType;
            break;
        }
    }

    const benHolder = document.getElementById('benPostHolder');
    const promoHolder = document.getElementById('promotedPostHolder');
    const voteBtn = document.getElementById('suggestedVoteButton');
    const vaasContainer = document.getElementById('vaasContainer');

    benHolder.style.display = 'none';
    promoHolder.style.display = 'none';
    vaasContainer.classList.remove('empty');

    if (vaasType === 0 && benPostList.length > 0) {
        const randomPost = getRandomPost(state.lastBlockChecked);
        if (!randomPost) {
            vaasContainer.classList.add('empty');
            benHolder.style.display = 'none';
            voteBtn.style.display = 'none';
            return;
        }

        const postTitle = await retrievePostInfo(randomPost, state.apiURL);
        if (!postTitle || postTitle === "(no title)") {
            // If post title couldn't be retrieved, skip this post and try another
            state.changePost = true;
            vaasContainer.classList.add('empty');
            benHolder.style.display = 'none';
            voteBtn.style.display = 'none';
            return;
        }

        const authorRep = await retrieveReputation(randomPost.author, state.apiURL);
        const followerCount = await retrieveFollowerCount(randomPost.author, state.apiURL);
        const followerInfo = await calcFollowerMedianAndCount(state.apiURL, randomPost.author);

        randomPost.authorReputation = authorRep;
        randomPost.authorFollowers = followerCount;
        randomPost.medianRepOfFollowers = followerInfo[0];

        const nullWeight = randomPost.nullBenWeight / 100.0;
        const medianFollowerRep = Math.round(randomPost.medianRepOfFollowers);
        const colorIndex = Math.min(10, Math.floor(nullWeight / 10));
        const borderColor = getBorderColor(colorIndex);

        document.getElementById('nullPctLabel').textContent = `@null%: ${nullWeight.toFixed(1)}, `;
        document.getElementById('nullPctLabel').style.color = borderColor;
        document.getElementById('authorLabel').textContent = `Author: ${randomPost.author}`;
        document.getElementById('authorRepLabel').textContent = `Reputation: ${authorRep}, `;
        document.getElementById('authorFollowersLabel').textContent = `# Followers: ${followerCount}, `;
        document.getElementById('medFollowerRep').textContent = `Median Follower Rep: ${medianFollowerRep}`;
        document.getElementById('pendingPayoutText').textContent = `Pending payout: ${randomPost.pendingPayout.toFixed(3)}, `;
        document.getElementById('netVotesText').textContent = `Net Votes: ${randomPost.netVotes}`;

        state.voteIndexValue = ((authorRep - 25) / 75.0)
            * (Math.log(followerCount) / Math.log(2))
            * ((medianFollowerRep - 25.0) / 75.0)
            * ((1 + nullWeight) / 100);

        state.webPath = randomPost.steemURL;
        state.webUrl = state.urlLeft + state.webPath;

        stopScrolling('scrollingText');
        setTimeout(() => {
            startScrolling('scrollingText', randomPost.title || "(no title)", VAAS_INTERVAL / 2);
        }, 50);

        benHolder.style.border = `${2 + Math.floor((1 + colorIndex) / 2)}px solid ${borderColor}`;
        promoHolder.style.display = 'none';
        benHolder.style.display = 'block';
        voteBtn.style.display = 'inline-block';

        benHolder.onclick = () => {
            if (state.webUrl) window.open(state.webUrl, '_blank');
        };

    } else if ((vaasType === 1 || vaasType === 2) && promoTransferList.length > 0) {
        const randomPromo = getRandomMemo(state.lastBlockChecked);
        if (!randomPromo) {
            vaasContainer.classList.add('empty');
            promoHolder.style.display = 'none';
            voteBtn.style.display = 'none';
            return;
        }

        const steemPath = extractSteemPath(randomPromo.xferMemo);
        const memoURL = extractUrl(randomPromo.xferMemo);
        const memoSender = randomPromo.xferFrom;
        const memoMessage = randomPromo.xferMemo;
        const memoTotalNormal = getTotalMemoPromos(memoSender, memoMessage);
        const formattedPromoNormal = memoTotalNormal.toFixed(3);

        document.getElementById('promoHeadingText').textContent = `Promo: ${formattedPromoNormal}`;

        if (steemPath) {
            voteBtn.style.display = 'inline-block';
            const authorPermlink = extractAuthorPermlink(steemPath);
            const promoAuthor = authorPermlink.split("/")[0];
            const promoPermlink = authorPermlink.split("/")[1];

            const promoPost = {
                author: promoAuthor,
                permlink: promoPermlink,
                nullBenWeight: -1,
                blockNum: randomPromo.blockNum,
                title: null,
                pendingPayout: 0,
                netVotes: 0,
                authorReputation: 0,
                authorFollowers: 0,
                medianRepOfFollowers: 0,
                steemURL: null
            };

            const postTitle = await retrievePostInfo(promoPost, state.apiURL);
            if (!postTitle || postTitle === "(no title)") {
                // If post title couldn't be retrieved, skip this promo and try another
                state.changePost = true;
                vaasContainer.classList.add('empty');
                voteBtn.style.display = 'none';
                return;
            }
            const promoRep = await retrieveReputation(promoAuthor, state.apiURL);
            const followerInfo = await calcFollowerMedianAndCount(state.apiURL, promoAuthor);

            promoPost.authorReputation = promoRep;
            promoPost.authorFollowers = followerInfo[1];
            promoPost.medianRepOfFollowers = followerInfo[0];

            document.getElementById('promoFromText').textContent = promoAuthor;
            document.getElementById('promoAuthorRepLabel').textContent = `Reputation: ${promoRep}`;
            document.getElementById('promoFollowerRep').textContent = `Median Follower Rep: ${(0.005 + promoPost.medianRepOfFollowers).toFixed(2)}`;
            document.getElementById('promoPendingPayoutText').textContent = `Pending payout: ${promoPost.pendingPayout.toFixed(3)}, `;
            document.getElementById('promoNetVotesText').textContent = `net votes: ${promoPost.netVotes}`;
            document.getElementById('promoAuthorFollowersLabel').textContent = `# Followers: ${promoPost.authorFollowers}`;

            state.voteIndexValue = ((promoPost.authorReputation - 25) / 75.0)
                * (Math.log(promoPost.authorFollowers) / Math.log(2))
                * ((promoPost.medianRepOfFollowers - 25.0) / 75.0)
                * Math.min(1, randomPromo.xferNormal / 0.1);

            stopScrolling('scrollPromoText');
            setTimeout(() => {
                startScrolling('scrollPromoText', promoPost.title || "(no title)", VAAS_INTERVAL / 2);
            }, 50);

            state.webPath = steemPath.startsWith('@') ? '/' + steemPath : steemPath;
            state.webUrl = state.urlLeft + state.webPath;

        } else {
            voteBtn.style.display = 'none';
            document.getElementById('promoFromText').textContent = '';
            document.getElementById('promoAuthorRepLabel').textContent = '';
            document.getElementById('promoFollowerRep').textContent = '';
            document.getElementById('promoAuthorFollowersLabel').textContent = '';
            document.getElementById('promoPendingPayoutText').textContent = '';
            document.getElementById('promoNetVotesText').textContent = '';

            document.getElementById('promoHeadingText').textContent = `${randomPromo.xferFrom} says:`;

            stopScrolling('scrollPromoText');
            setTimeout(() => {
                startScrolling('scrollPromoText', randomPromo.xferMemo, VAAS_INTERVAL / 2);
            }, 50);

            if (memoURL) {
                state.webUrl = memoURL;
            } else {
                state.webPath = '/@' + randomPromo.xferFrom;
                state.webUrl = state.urlLeft + state.webPath;
            }
        }

        const baseScore = 0.001;
        let colorIndex;
        if (memoTotalNormal < baseScore) colorIndex = 0;
        else if (memoTotalNormal < baseScore * 100) colorIndex = 2;
        else if (memoTotalNormal < baseScore * 10000) colorIndex = 5;
        else if (memoTotalNormal < baseScore * 100000) colorIndex = 8;
        else colorIndex = 10;

        const borderColor = getBorderColor(colorIndex);
        document.getElementById('promoHeadingText').style.color = borderColor;
        promoHolder.style.border = `${2 + Math.floor((1 + colorIndex) / 2)}px solid ${borderColor}`;

        benHolder.style.display = 'none';
        promoHolder.style.display = 'block';

        promoHolder.onclick = () => {
            if (state.webUrl) window.open(state.webUrl, '_blank');
        };
    } else {
        vaasContainer.classList.add('empty');
        voteBtn.style.display = 'none';
    }
}

function getBorderColor(index) {
    const colors = [
        'rgba(255, 100, 0, 0.7)',
        'rgba(255, 100, 0, 0.75)',
        'rgba(255, 128, 64, 0.7)',
        'rgba(255, 128, 64, 0.75)',
        'rgba(255, 128, 64, 0.8)',
        'rgba(253, 152, 0, 0.7)',
        'rgba(253, 152, 0, 0.75)',
        'rgba(253, 152, 0, 0.8)',
        'rgba(0, 253, 228, 0.5)',
        'rgba(0, 253, 228, 0.6)',
        'rgba(50, 132, 255, 0.7)'
    ];
    return colors[Math.min(index, 10)];
}

// ============================================================
// Utility Functions
// ============================================================

function extractAuthorPermlink(input) {
    const match = input.match(/.*@([^/]+)\/([^/]+)$/);
    if (match) {
        return match[1] + "/" + match[2];
    }
    return null;
}

function extractSteemPath(memo) {
    const match = memo.match(/@([a-z0-9-]+)\/([a-z0-9-]+)/i);
    if (match) {
        return "@" + match[1] + "/" + match[2];
    }
    return null;
}

function extractUrl(memo) {
    const match = memo.match(/https?:\/\/[^\s]+/);
    return match ? match[0] : null;
}

// ============================================================
// Vote Suggestion Table
// ============================================================

function showVoteTable() {
    const modal = document.getElementById('voteModal');
    const tbody = document.getElementById('voteTableBody');
    tbody.innerHTML = '';

    for (let votesPerDay = 12; votesPerDay < 100; votesPerDay += 12) {
        let voteSuggestion = votesPerDay === 12
            ? 100
            : Math.round((2000.0 / votesPerDay) * state.voteIndexValue);
        voteSuggestion = Math.min(100, Math.max(5, voteSuggestion));

        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = votesPerDay;
        const td2 = document.createElement('td');
        td2.textContent = voteSuggestion + '%';
        tr.appendChild(td1);
        tr.appendChild(td2);
        tbody.appendChild(tr);
    }

    document.getElementById('voteLink').href = state.webUrl || '#';
    modal.style.display = 'flex';
}

// ============================================================
// Main Update Loop
// ============================================================

async function mainLoop() {
    if (state.paused) {
        state.lastPollValid = true;
        return;
    }

    if (!state.apiURL) {
        state.failCount = 0;
        state.apiURL = API_SERVERS[Math.floor(Math.random() * API_SERVERS.length)];
        document.getElementById('apiServerSelect').style.background = 'goldenrod';
    }

    try {
        const nextBlock = await getNextBlockToCheck();
        if (nextBlock > state.lastBlockChecked || state.lastBlockChecked === 0) {
            const rc = await countOpsInBlock(nextBlock, state.apiURL);
            if (rc !== 0) {
                state.lastPollValid = false;
            }
        }
    } catch (e) {
        console.error("Error in main loop:", e);
        state.lastPollValid = false;
    }

    if (!state.lastPollValid) {
        state.failCount++;
        if (state.failCount > MAX_FAIL) {
            state.apiURL = API_SERVERS[Math.floor(Math.random() * API_SERVERS.length)];
            document.getElementById('apiServerSelect').value = state.apiURL;
            document.getElementById('apiServerSelect').style.background = 'goldenrod';
            state.failCount = 0;
            console.log("Switching APIs due to connectivity issue.");
        } else {
            document.getElementById('apiServerSelect').style.background = 'red';
        }
    } else {
        state.failCount = 0;
        document.getElementById('apiServerSelect').style.background = 'lightgreen';
    }

    const speed = state.opsByName[state.filter] || 0;
    drawGauge(speed);

    state.currBlock = state.lastBlockChecked;
    if (state.prevBlock !== state.currBlock) {
        const trackTypes = ['all', 'comment', 'vote', 'transfer', 'custom_json'];
        trackTypes.forEach(t => {
            const val = state.opsByName[t] || 0;
            dataQueues[t].shift();
            dataQueues[t].push(val);
        });
        drawGraph();
        state.prevBlock = state.currBlock;
    }

    updateDashLabels();
    await updateVAAS();
}

async function getNextBlockToCheck() {
    try {
        const lib = await getLastIrreversibleBlock(state.apiURL);
        if (state.lastBlockChecked === 0) {
            return lib;
        } else if (state.lastBlockChecked < lib) {
            return state.lastBlockChecked + 1;
        }
        return state.lastBlockChecked;
    } catch (e) {
        console.error("Error getting last irreversible block:", e);
        return state.lastBlockChecked;
    }
}

// ============================================================
// Reset
// ============================================================

function resetCounters() {
    state.opsByName = {};
    state.opsByNameCum = {};
    state.opsByNameMax = {};
    state.opsByNameAvg = {};
    state.opsByNameCount = {};
    state.displayMax = 0;
    state.displayAvg = 0;
    state.numBlocks = 0;

    blockQueue = [];
    for (const key in dataQueues) {
        dataQueues[key] = [];
        for (let i = 0; i < 100; i++) dataQueues[key].push(0);
    }

    drawGauge(0);
    drawGraph();
    updateDashLabels();
}

// ============================================================
// Filter Handling
// ============================================================

function handleFilterAction(filterType) {
    const voteCb = document.getElementById('voteFilter');
    const transferCb = document.getElementById('transferFilter');
    const commentCb = document.getElementById('commentFilter');
    const customJsonCb = document.getElementById('customJsonFilter');

    let targetCb;
    let mappedFilter;
    switch (filterType) {
        case 'comment':
            targetCb = commentCb;
            mappedFilter = 'comment';
            break;
        case 'vote':
            targetCb = voteCb;
            mappedFilter = 'vote';
            break;
        case 'transfer':
            targetCb = transferCb;
            mappedFilter = 'transfer';
            break;
        case 'customJson':
            targetCb = customJsonCb;
            mappedFilter = 'custom_json';
            break;
    }

    if (targetCb && targetCb.checked) {
        if (commentCb !== targetCb) commentCb.checked = false;
        if (voteCb !== targetCb) voteCb.checked = false;
        if (transferCb !== targetCb) transferCb.checked = false;
        if (customJsonCb !== targetCb) customJsonCb.checked = false;
        state.filter = mappedFilter;
    } else {
        state.filter = 'all';
    }

    drawGauge(state.opsByName[state.filter] || 0);
    drawGraph();
    updateDashLabels();
}

// ============================================================
// Initialization
// ============================================================

function init() {
    const apiSelect = document.getElementById('apiServerSelect');
    API_SERVERS.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        apiSelect.appendChild(opt);
    });
    apiSelect.onchange = () => {
        state.apiURL = apiSelect.value;
        apiSelect.style.background = 'goldenrod';
    };

    const webSelect = document.getElementById('webServerSelect');
    WEB_SERVERS.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        webSelect.appendChild(opt);
    });
    webSelect.onchange = () => {
        const oldUrl = new URL(state.webUrl);
        const oldUrlLeft = oldUrl.protocol + '//' + oldUrl.host;
        state.urlLeft = webSelect.value;
        if (WEB_SERVERS.includes(oldUrlLeft)) {
            state.webUrl = state.urlLeft + oldUrl.pathname;
        }
        webSelect.style.background = 'lightgreen';
    };

    document.getElementById('commentFilter').onchange = () => handleFilterAction('comment');
    document.getElementById('voteFilter').onchange = () => handleFilterAction('vote');
    document.getElementById('transferFilter').onchange = () => handleFilterAction('transfer');
    document.getElementById('customJsonFilter').onchange = () => handleFilterAction('customJson');

    document.getElementById('resetButton').onclick = resetCounters;

    document.getElementById('pauseButton').onclick = () => {
        state.paused = !state.paused;
        document.getElementById('pauseButton').textContent = state.paused ? 'Continue' : 'Pause';
    };

    document.getElementById('suggestedVoteButton').onclick = showVoteTable;

    document.getElementById('closeModal').onclick = () => {
        document.getElementById('voteModal').style.display = 'none';
    };
    window.onclick = (e) => {
        if (e.target === document.getElementById('voteModal')) {
            document.getElementById('voteModal').style.display = 'none';
        }
    };

    document.getElementById('gaugeDisplay').onclick = () => {
        document.getElementById('gaugeDisplay').style.display = 'none';
        document.getElementById('histGraphDisplay').style.display = 'block';
        drawGraph();
    };
    document.getElementById('histGraphDisplay').onclick = () => {
        document.getElementById('histGraphDisplay').style.display = 'none';
        document.getElementById('gaugeDisplay').style.display = 'block';
    };

    setInterval(mainLoop, UPDATE_INTERVAL);
    setTimeout(vaasLoop, 1000);
}

document.addEventListener('DOMContentLoaded', init);