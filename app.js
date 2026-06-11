/* ================== PWA INSTALL PROMPT ================== */
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    setTimeout(() => showInstallBanner(), 3000);
});

function showInstallBanner() {
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (document.getElementById('pwa-install-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.innerHTML = `
        <div style="
            position:fixed;bottom:90px;left:50%;transform:translateX(-50%);
            background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);
            border:1px solid rgba(255,79,163,0.4);border-radius:16px;
            padding:16px 20px;display:flex;align-items:center;gap:14px;
            box-shadow:0 8px 32px rgba(255,79,163,0.25);
            z-index:9999;width:calc(100% - 40px);max-width:400px;
            animation:slideUp 0.4s cubic-bezier(0.175,0.885,0.32,1.275);">
            <img src="/icon-192.png" style="width:44px;height:44px;border-radius:10px;flex-shrink:0;">
            <div style="flex:1;">
                <div style="font-weight:600;color:#fff;font-size:0.95rem;">Install PageFlow</div>
                <div style="color:rgba(255,255,255,0.6);font-size:0.78rem;margin-top:2px;">Add to Home Screen for the full app experience</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
                <button id="pwa-install-yes" style="background:linear-gradient(135deg,#ff4fa3,#7c3aed);color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:0.8rem;font-weight:600;cursor:pointer;">Install</button>
                <button id="pwa-install-no" style="background:transparent;color:rgba(255,255,255,0.5);border:none;font-size:0.75rem;cursor:pointer;">Not now</button>
            </div>
        </div>`;
    document.body.appendChild(banner);

    document.getElementById('pwa-install-yes').addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        banner.remove();
    });
    document.getElementById('pwa-install-no').addEventListener('click', () => banner.remove());
}

window.addEventListener('appinstalled', () => {
    const b = document.getElementById('pwa-install-banner');
    if (b) b.remove();
    deferredInstallPrompt = null;
});

// Basic local state
const state = {
    user: JSON.parse(localStorage.getItem('pageflow_user')) || null,
    books: [], // Will populate from IndexedDB
    recentBookId: localStorage.getItem('pageflow_recent_book') || null,
    highlights: JSON.parse(localStorage.getItem('pageflow_highlights')) || [],
    currentBook: null,
    pdfDoc: null,
    pageNum: 1,
    pageRendering: false,
    pageNumPending: null,
    scale: 1.0,
    canvas: document.getElementById('pdf-render'),
    ctx: document.getElementById('pdf-render') ? document.getElementById('pdf-render').getContext('2d') : null
};

/* ================== INDEXED DB SETUP ================== */
// LocalStorage has a strict 5MB limit. IndexedDB holds GBs.
const DB_NAME = 'PageFlowOfflineDB';
const DB_VERSION = 1;
const STORE_NAME = 'pdf_books';
let offlineDB;

function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (e) => reject(e.target.error);
        request.onsuccess = (e) => {
            offlineDB = e.target.result;
            resolve();
        };
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });
}

function saveBookToIndexedDB(book) {
    return new Promise((resolve, reject) => {
        if (!offlineDB) return resolve();
        const transaction = offlineDB.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(book);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

function getBooksFromIndexedDB(userId) {
    return new Promise((resolve, reject) => {
        if (!offlineDB) return resolve([]);
        const transaction = offlineDB.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = (e) => {
            // Filter by user ID so users only see their own local devices books
            const allBooks = e.target.result || [];
            const userBooks = allBooks.filter(b => b.userId === userId).sort((a, b) => b.date - a.date);
            resolve(userBooks);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

function deleteBookFromIndexedDB(bookId) {
    return new Promise((resolve, reject) => {
        if (!offlineDB) return resolve();
        const transaction = offlineDB.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(bookId);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

// Setup PDF.js worker
const pdfjsLib = window['pdfjs-dist/build/pdf'];
if (pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// DOM Elements
const views = document.querySelectorAll('.view');
const loader = document.getElementById('loader');

// Navigation
function showView(viewId) {
    views.forEach(view => view.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');

    // Update bottom nav
    document.querySelectorAll('.nav-item').forEach(btn => {
        if (btn.dataset.target === viewId) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    if (viewId === 'view-home') loadHome();
    if (viewId === 'view-highlights') loadHighlightsView();
    if (viewId === 'view-profile') loadProfileView();
}

// Bottom Nav Listeners
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        if (target) showView(target);
    });
});

/* ================== FIREBASE INITIALIZATION ================== */
// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyAPR69Og5Llj8m0jQRu2M6-IUAsca7ccBM",
    authDomain: "pageflow-28adb.firebaseapp.com",
    projectId: "pageflow-28adb",
    storageBucket: "pageflow-28adb.firebasestorage.app",
    messagingSenderId: "771868487834",
    appId: "1:771868487834:web:5062faa8b22d02cd81af23",
    measurementId: "G-4YDGN78LYH"
};

let app, auth, db, storage, googleProvider;

// Initialize Firebase - with offline session restore fallback
function initFirebase() {
    if (!window.firebaseModules) {
        setTimeout(initFirebase, 100);
        return;
    }
    const fm = window.firebaseModules;
    app = fm.initializeApp(firebaseConfig);
    auth = fm.getAuth(app);
    db = fm.getFirestore(app);
    storage = fm.getStorage(app);

    googleProvider = new fm.GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: 'select_account' });

    // --- OFFLINE BOOT GUARD ---
    // Firebase's onAuthStateChanged can hang forever when there's no internet.
    // If we have a cached user session in localStorage, boot offline immediately
    // after a short grace period so the reader never shows the login screen offline.
    let authResolved = false;
    const cachedUser = JSON.parse(localStorage.getItem('pageflow_user'));

    const offlineTimer = setTimeout(async () => {
        if (authResolved) return; // Firebase already responded, all good
        authResolved = true;
        if (cachedUser) {
            // No internet, but we have a saved session → boot offline
            console.warn('[PageFlow] Offline detected – booting from cached session.');
            state.user = cachedUser;
            loader.style.display = 'flex';
            try {
                await initIndexedDB();
                state.books = await getBooksFromIndexedDB(cachedUser.uid);
            } catch (e) {
                console.error("IndexedDB error (offline):", e);
            }
            loader.style.display = 'none';
            showView('view-home');

            // Show subtle offline indicator
            const offlineBadge = document.createElement('div');
            offlineBadge.innerHTML = `<div style="
                position:fixed;top:10px;left:50%;transform:translateX(-50%);
                background:rgba(0,0,0,0.7);color:#fff;padding:6px 16px;
                border-radius:20px;font-size:0.75rem;z-index:9999;
                display:flex;align-items:center;gap:6px;">
                <i class=\"fa fa-wifi\" style=\"opacity:0.5\"></i> Offline Mode
            </div>`;
            document.body.appendChild(offlineBadge);
            setTimeout(() => offlineBadge.remove(), 4000);
        } else {
            // No internet AND no cached session → show login
            showView('view-login');
        }
    }, 4000); // Wait 4 seconds for Firebase before assuming offline

    // Normal Firebase auth flow
    fm.onAuthStateChanged(auth, async (user) => {
        clearTimeout(offlineTimer);

        // If user status is unchanged, skip re-initialization (prevents multiple triggers)
        if (user && state.user && state.user.uid === user.uid) {
            authResolved = true;
            return;
        }

        authResolved = true;

        if (user) {
            state.user = {
                email: user.email,
                uid: user.uid,
                displayName: user.displayName || user.email.split('@')[0]
            };
            localStorage.setItem('pageflow_user', JSON.stringify(state.user));

            loader.style.display = 'flex';
            try {
                await initIndexedDB();
                state.books = await getBooksFromIndexedDB(user.uid);
            } catch (e) {
                console.error("Error fetching books from IndexedDB:", e);
            }
            loader.style.display = 'none';
            showView('view-home');
        } else {
            state.user = null;
            localStorage.removeItem('pageflow_user');
            state.books = [];
            showView('view-login');
        }
    });
}
initFirebase();

/* ================== UTILITIES (Hashing) ================== */
async function hashPassword(password) {
    const salt = "PageFlow_Secret_Salt_2026!";
    const combined = password + salt;

    // crypto.subtle is only available on localhost or HTTPS. 
    // If the user is testing on a mobile phone over HTTP LAN (192.168.x.x), it throws an error.
    if (crypto && crypto.subtle) {
        const encoder = new TextEncoder();
        const data = encoder.encode(combined);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
        // Fallback for non-secure local LAN testing
        return btoa(combined);
    }
}

/* ================== AUTH LOGIC ================== */
let isLoginMode = true;

document.getElementById('tab-login')?.addEventListener('click', (e) => {
    isLoginMode = true;
    e.target.classList.add('active');
    document.getElementById('tab-signup').classList.remove('active');
    document.getElementById('auth-submit').textContent = 'Login';
    document.getElementById('auth-error').textContent = '';
});

document.getElementById('tab-signup')?.addEventListener('click', (e) => {
    isLoginMode = false;
    e.target.classList.add('active');
    document.getElementById('tab-login').classList.remove('active');
    document.getElementById('auth-submit').textContent = 'Signup';
    document.getElementById('auth-error').textContent = '';
});

document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const rawPassword = document.getElementById('password').value;
    const errorEl = document.getElementById('auth-error');

    loader.style.display = 'flex';
    errorEl.textContent = '';

    try {
        const hashedPassword = await hashPassword(rawPassword);
        const fm = window.firebaseModules;

        if (isLoginMode) {
            // LOGIN
            await fm.signInWithEmailAndPassword(auth, email, hashedPassword);
        } else {
            // SIGNUP
            const userCredential = await fm.createUserWithEmailAndPassword(auth, email, hashedPassword);
            // Add user doc to Firestore
            await fm.setDoc(fm.doc(db, "users", userCredential.user.uid), {
                email: email,
                createdAt: Date.now()
            });
        }
    } catch (error) {
        console.error("Auth error:", error);
        // Map Firebase errors to user friendly messages
        if (error.code === 'auth/email-already-in-use') errorEl.textContent = 'Email already in use.';
        else if (error.code === 'auth/invalid-credential') errorEl.textContent = 'Invalid email or password.';
        else errorEl.textContent = error.message || 'Authentication failed.';

    } finally {
        loader.style.display = 'none';
    }
});

document.getElementById('google-auth-btn')?.addEventListener('click', async () => {
    const fm = window.firebaseModules;
    try {
        loader.style.display = 'flex';
        await fm.signInWithPopup(auth, googleProvider);
    } catch (error) {
        console.error("Google login error", error);

        let errorMsg = error.message || "Google login failed.";
        if (error.code === 'auth/configuration-not-found') {
            errorMsg = "Setup required: Please enable 'Google' inside the Firebase Console -> Authentication -> Sign-in Method tab.";
        }

        document.getElementById('auth-error').textContent = errorMsg;
    } finally {
        loader.style.display = 'none';
    }
});

// Sign out is now in Profile view
document.getElementById('logout-btn')?.addEventListener('click', async () => {
    const fm = window.firebaseModules;

    // Clear local cache immediately for instant UI feedback
    localStorage.removeItem('pageflow_user');
    state.user = null;
    state.books = [];

    if (fm && auth) {
        try {
            await fm.signOut(auth);
        } catch (e) {
            console.error("Signout error", e);
        }
    }

    // Force redirect in case onAuthStateChanged doesn't fire or is slow
    showView('view-login');
});

// Mini profile button on home view
document.getElementById('mini-profile-btn')?.addEventListener('click', () => {
    showView('view-profile');
});

/* ================== DARK MODE ================== */
const darkModeToggle = document.getElementById('dark-mode-toggle');
// Check local storage for preference
if (localStorage.getItem('pageflow_darkmode') === 'true') {
    document.body.classList.add('dark-theme');
    if (darkModeToggle) darkModeToggle.checked = true;
}

darkModeToggle?.addEventListener('change', (e) => {
    if (e.target.checked) {
        document.body.classList.add('dark-theme');
        localStorage.setItem('pageflow_darkmode', 'true');
    } else {
        document.body.classList.remove('dark-theme');
        localStorage.setItem('pageflow_darkmode', 'false');
    }
});

/* ================== GEMINI API KEY CONFIG ================== */
const apiKeyInput = document.getElementById('gemini-api-key-input');
const saveApiKeyBtn = document.getElementById('save-api-key-btn');
if (apiKeyInput) {
    apiKeyInput.value = localStorage.getItem('pageflow_gemini_api_key') || '';
}
saveApiKeyBtn?.addEventListener('click', () => {
    const keyVal = apiKeyInput.value.trim();
    if (keyVal) {
        localStorage.setItem('pageflow_gemini_api_key', keyVal);
        alert('Gemini API key saved successfully!');
    } else {
        localStorage.removeItem('pageflow_gemini_api_key');
        alert('Gemini API key removed. Using default key.');
    }
});


/* ================== HOME LIBRARY ================== */
function loadHome() {
    const grid = document.getElementById('books-grid');
    const recentSec = document.getElementById('recent-book-sec');
    const recentCard = document.getElementById('recent-book-card');

    grid.innerHTML = '';

    if (state.books.length === 0) {
        grid.innerHTML = '<div class="empty-state">No books yet. Upload one!</div>';
    } else {
        state.books.forEach(book => {
            const card = document.createElement('div');
            card.className = 'book-card';
            card.innerHTML = `
                <button class="delete-book-btn" data-id="${book.id}" title="Delete Book">
                    <i class="fa fa-trash"></i>
                </button>
                <i class="fa fa-file-pdf icon"></i>
                <h5>${book.title}</h5>
                <p>${new Date(book.date).toLocaleDateString()}</p>
            `;

            // Handle delete action
            const delBtn = card.querySelector('.delete-book-btn');
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation(); // prevent card click
                if (confirm("Are you sure you want to permanently delete this book?")) {
                    loader.style.display = 'flex';
                    try {
                        const fm = window.firebaseModules;
                        if (fm && db) {
                            await fm.deleteDoc(fm.doc(db, "books", book.id)).catch(e => console.warn("Could not delete from cloud", e));
                        }
                        await initIndexedDB();
                        await deleteBookFromIndexedDB(book.id);
                        state.books = state.books.filter(b => b.id !== book.id);

                        // Clear recent if it was this one
                        if (state.recentBookId === book.id) {
                            state.recentBookId = null;
                            localStorage.removeItem('pageflow_recent_book');
                        }
                        loadHome();
                    } catch (err) {
                        console.error("Delete err", err);
                    } finally {
                        loader.style.display = 'none';
                    }
                }
            });

            card.addEventListener('click', () => openBook(book));
            grid.appendChild(card);
        });
    }

    const storedRecentBook = localStorage.getItem('pageflow_recent_book');
    if (storedRecentBook) {
        state.recentBookId = storedRecentBook;
    }

    if (state.recentBookId) {
        const recentBook = state.books.find(b => b.id === state.recentBookId);
        if (recentBook) {
            recentSec.style.display = 'block';
            recentCard.innerHTML = `
                <h4>${recentBook.title}</h4>
                <p style="margin-top: 10px; font-size: 0.9rem;">Page ${recentBook.lastPage || 1}</p>
            `;
            recentCard.onclick = () => openBook(recentBook);
        } else {
            recentSec.style.display = 'none';
        }
    } else {
        recentSec.style.display = 'none';
    }
}

// Upload Book
const uploadBtn = document.getElementById('upload-fab');
const fileInput = document.getElementById('pdf-upload');

uploadBtn?.addEventListener('click', () => fileInput.click());

fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || file.type !== 'application/pdf') return;

    loader.style.display = 'flex';

    try {
        const fm = window.firebaseModules;
        if (state.user) {

            // Because Firebase Storage requires billing for some setups, we will 
            // store the heavy PDF data locally (Base64 -> localStorage / IndexedDB),
            // and optionally just sync the lightweight metadata to Firebase Firestore.

            const base64data = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (event) => resolve(event.target.result);
                reader.readAsDataURL(file);
            });

            const newBook = {
                id: 'book_' + Date.now(),
                title: file.name.replace('.pdf', ''),
                date: Date.now(),
                dataUrl: base64data,
                lastPage: 1,
                lastScale: null,
                userId: state.user.uid
            };

            // Save Metadata to Firestore
            if (fm && db) {
                try {
                    // We DO NOT save dataUrl to Firestore because 1MB document limit will break Base64 PDFs.
                    const bookMeta = { ...newBook, dataUrl: 'local' };
                    await fm.setDoc(fm.doc(db, "books", newBook.id), bookMeta);
                } catch (e) { console.warn("Could not sync metadata to cloud", e); }
            }

            // Save actual PDF to IndexedDB bypassing localStorage limits completely
            await initIndexedDB();
            await saveBookToIndexedDB(newBook);

            state.books.unshift(newBook);
            loadHome();

        } else {
            throw new Error("Missing user login.");
        }
    } catch (err) {
        console.error("Upload error", err);
        alert(`Failed to upload book: ${err.message} `);
    } finally {
        loader.style.display = 'none';
        fileInput.value = ''; // Reset input
    }
});

/* ================== PDF READER ================== */
async function openBook(book) {
    state.currentBook = book;
    state.pageNum = book.lastPage || 1;
    state.scale = book.lastScale || 1.0;

    // Explicitly reset PDF rendering flags in case another document caused a lock
    state.pageRendering = false;
    state.pageNumPending = null;

    // Cleanup old text layer and selections to prevent overlap
    window.getSelection().removeAllRanges();
    const existingTextLayer = document.getElementById('text-layer');
    if (existingTextLayer) existingTextLayer.innerHTML = '';

    document.getElementById('reader-title').textContent = book.title;
    showView('view-reader');
    loader.style.display = 'flex';

    try {
        // Destroy previous document cleanly to free memory and unlock text/render workers
        if (state.pdfDoc) {
            await state.pdfDoc.destroy();
            state.pdfDoc = null;
        }

        // Load PDF from dataUrl
        const loadingTask = pdfjsLib.getDocument(book.dataUrl);
        state.pdfDoc = await loadingTask.promise;
        document.getElementById('page-count').textContent = state.pdfDoc.numPages;

        // Auto-scale correctly for device width
        const firstPage = await state.pdfDoc.getPage(1);
        const unscaledViewport = firstPage.getViewport({ scale: 1.0 });
        
        let desiredWidth = window.innerWidth - 40;
        if (desiredWidth > 800) desiredWidth = 800;
        const fitScale = desiredWidth / unscaledViewport.width;

        if (!book.lastScale || (window.innerWidth < 768 && (unscaledViewport.width * state.scale > window.innerWidth))) {
            state.scale = fitScale;
        }

        renderPage(state.pageNum);
    } catch (error) {
        console.error("Error rendering PDF:", error);
        alert("Failed to load PDF.");
    } finally {
        loader.style.display = 'none';
    }
}

async function renderPage(num) {
    state.pageRendering = true;

    const page = await state.pdfDoc.getPage(num);
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: state.scale });

    state.canvas.width = Math.floor(viewport.width * dpr);
    state.canvas.height = Math.floor(viewport.height * dpr);
    state.canvas.style.width = viewport.width + 'px';
    state.canvas.style.height = viewport.height + 'px';

    // Adjust the wrapper to match canvas size exactly for absolute positioning overlay
    const wrapper = document.getElementById('pdf-wrapper');
    wrapper.style.width = viewport.width + 'px';
    wrapper.style.height = viewport.height + 'px';

    const renderContext = {
        canvasContext: state.ctx,
        viewport: viewport,
        transform: [dpr, 0, 0, dpr, 0, 0]
    };

    await page.render(renderContext).promise;

    // Recreate Text Layer DOM node to fully disconnect old PDF.js event bindings
    let textLayerDiv = document.getElementById('text-layer');
    if (textLayerDiv) textLayerDiv.remove();
    textLayerDiv = document.createElement('div');
    textLayerDiv.id = 'text-layer';
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.left = state.canvas.offsetLeft + 'px';
    textLayerDiv.style.top = state.canvas.offsetTop + 'px';
    textLayerDiv.style.height = viewport.height + 'px';
    textLayerDiv.style.width = viewport.width + 'px';
    textLayerDiv.style.setProperty('--scale-factor', viewport.scale);
    document.getElementById('pdf-wrapper').appendChild(textLayerDiv);

    const textContent = await page.getTextContent();

    // Create text layer
    try {
        await pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport: viewport,
            textDivs: []
        }).promise;
    } catch (err) {
        console.warn("Text layer error", err);
        alert("Text selection engine failed to load for this document.");
    }

    // Render persistent highlights on top of canvas visually
    document.querySelectorAll('.page-highlight').forEach(el => el.remove());
    if (state.currentBook) {
        const pageHighlights = state.highlights.filter(h => h.bookId === state.currentBook.id && h.page === num);

        pageHighlights.forEach(hl => {
            if (!hl.rects) return;

            let rgba = 'rgba(255, 235, 59, 0.4)'; // yellow
            if (hl.color === 'pink') rgba = 'rgba(255, 192, 203, 0.5)';
            if (hl.color === 'blue') rgba = 'rgba(33, 150, 243, 0.4)';
            if (hl.color === 'green') rgba = 'rgba(76, 175, 80, 0.4)';

            hl.rects.forEach(rect => {
                const div = document.createElement('div');
                div.className = 'page-highlight';
                div.style.left = (rect.x * state.scale) + 'px';
                div.style.top = (rect.y * state.scale) + 'px';
                div.style.width = (rect.width * state.scale) + 'px';
                div.style.height = (rect.height * state.scale) + 'px';
                div.style.backgroundColor = rgba;
                wrapper.appendChild(div);
            });
        });
    }

    state.pageRendering = false;
    if (state.pageNumPending !== null) {
        renderPage(state.pageNumPending);
        state.pageNumPending = null;
    }

    document.getElementById('page-num').textContent = num;
}

function queueRenderPage(num) {
    if (state.pageRendering) {
        state.pageNumPending = num;
    } else {
        renderPage(num);
    }
}

// Reader Controls
document.getElementById('prev-page')?.addEventListener('click', () => {
    if (state.pageNum <= 1) return;
    state.pageNum--;
    queueRenderPage(state.pageNum);
});

document.getElementById('next-page')?.addEventListener('click', () => {
    if (state.pageNum >= state.pdfDoc.numPages) return;
    state.pageNum++;
    queueRenderPage(state.pageNum);
});

document.getElementById('zoom-in')?.addEventListener('click', () => {
    state.scale += 0.2;
    document.getElementById('zoom-level').textContent = Math.round(state.scale * 100) + '%';
    queueRenderPage(state.pageNum);
});

document.getElementById('zoom-out')?.addEventListener('click', () => {
    if (state.scale <= 0.6) return;
    state.scale -= 0.2;
    document.getElementById('zoom-level').textContent = Math.round(state.scale * 100) + '%';
    queueRenderPage(state.pageNum);
});

// Save "Continue Later" state + Animation
document.getElementById('continue-later-btn')?.addEventListener('click', (e) => {
    if (!state.currentBook) return; // Ensure a book is open

    state.recentBookId = state.currentBook.id;
    state.currentBook.lastPage = state.pageNum;
    state.currentBook.lastScale = state.scale;
    localStorage.setItem('pageflow_recent_book', state.recentBookId);

    // Save to IndexedDB to keep state
    saveBookToIndexedDB(state.currentBook);

    // Book update mock in DB
    const fm = window.firebaseModules;
    if (fm && db && state.user) {
        fm.updateDoc(fm.doc(db, "books", state.currentBook.id), {
            lastPage: state.pageNum,
            lastScale: state.scale
        }).catch(err => console.error("Could not update last page in cloud", err));
    }

    // Play animation
    const btn = e.currentTarget;
    btn.classList.add('pop-anim');
    btn.style.color = 'var(--primary-btn)';
    setTimeout(() => {
        btn.classList.remove('pop-anim');
        btn.style.color = ''; // Reset color
        showView('view-home'); // Navigate after animation
    }, 500);
});

document.getElementById('reader-back')?.addEventListener('click', () => {
    showView('view-home');
});

/* ================== HIGHLIGHT SYSTEM ================== */
let selectedText = '';
let selectedRects = [];

// Auto-show Highlight Picker on text selection for both Desktop and Mobile
function handleTextSelection(e) {
    // Ignore clicks inside the highlight picker or AI modal
    if (e.target.closest('#highlight-picker') || e.target.closest('#ai-summary-modal')) {
        return;
    }

    const sel = window.getSelection();
    const isInReader = document.getElementById('view-reader').classList.contains('active');

    if (sel.rangeCount > 0 && sel.toString().trim().length > 0 && isInReader) {
        selectedText = sel.toString().trim();
        const range = sel.getRangeAt(0);
        
        // Ensure the selection is actually inside the PDF wrapper
        if (!range.commonAncestorContainer.parentElement?.closest('#pdf-wrapper')) {
            document.getElementById('highlight-picker').style.display = 'none';
            return;
        }

        const rects = range.getClientRects();
        const wrapper = document.getElementById('pdf-wrapper');
        const wrapperRect = wrapper.getBoundingClientRect();

        selectedRects = [];
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            selectedRects.push({
                x: (r.left - wrapperRect.left) / state.scale,
                y: (r.top - wrapperRect.top) / state.scale,
                width: r.width / state.scale,
                height: r.height / state.scale
            });
        }

        const picker = document.getElementById('highlight-picker');
        picker.style.display = 'flex';
        picker.style.position = 'fixed';

        // Coordinates logic
        const touch = e.changedTouches ? e.changedTouches[0] : e;
        const clientY = touch.clientY;
        const clientX = touch.clientX;

        // Position above the selection if possible, or below
        const firstRect = rects[0];
        if (firstRect) {
            picker.style.top = Math.max(20, (firstRect.top - 70)) + 'px';
            picker.style.left = Math.max(100, Math.min(window.innerWidth - 100, (firstRect.left + firstRect.width / 2))) + 'px';
        } else {
            picker.style.top = (clientY > window.innerHeight - 100 ? clientY - 80 : clientY + 20) + 'px';
            picker.style.left = Math.max(100, Math.min(window.innerWidth - 100, clientX)) + 'px';
        }
    } else {
        document.getElementById('highlight-picker').style.display = 'none';
        if (!e.target.closest('#ai-summary-modal')) {
            document.getElementById('ai-summary-modal').style.display = 'none';
        }
    }
}

document.addEventListener('mouseup', handleTextSelection);
document.addEventListener('touchend', handleTextSelection);

let selectedColor = 'yellow';
document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        selectedColor = e.target.dataset.color;
    });
});

document.getElementById('save-highlight-btn')?.addEventListener('click', () => {
    if (!state.currentBook || !selectedText) return;

    const highlight = {
        id: 'hl_' + Date.now(),
        bookId: state.currentBook.id,
        bookTitle: state.currentBook.title,
        page: state.pageNum,
        text: selectedText,
        rects: selectedRects,
        color: selectedColor,
        date: Date.now()
    };

    state.highlights.push(highlight);
    localStorage.setItem('pageflow_highlights', JSON.stringify(state.highlights));

    document.getElementById('highlight-picker').style.display = 'none';
    window.getSelection().removeAllRanges();

    // Visually redraw page to manifest the new highlight box immediately
    renderPage(state.pageNum);
});

/* ================== AI SUMMARIZER LOGIC ================== */
const aiModal = document.getElementById('ai-summary-modal');
const aiSummaryText = document.getElementById('ai-summary-text');
const aiLoading = document.getElementById('ai-loading');

document.getElementById('ai-summarize-btn')?.addEventListener('click', async () => {
    if (!selectedText) return;

    // Hide picker, show modal
    document.getElementById('highlight-picker').style.display = 'none';
    aiModal.style.display = 'flex';
    aiSummaryText.textContent = '';
    aiLoading.style.display = 'flex';

    try {
        const summary = await getAIResponse(selectedText);
        aiLoading.style.display = 'none';
        await typeWriterEffect(aiSummaryText, summary);
    } catch (error) {
        console.error("AI summarization failure:", error);
        aiLoading.style.display = 'none';
        aiSummaryText.innerHTML = `<span style="color:#ef4444; font-size: 0.9rem; display: block; padding: 10px;">
            <strong>AI Assistant Error:</strong><br>${error.message}<br><br>
            Please check your internet connection or update your Gemini API Key in the Profile tab.
        </span>`;
    }
});

async function getAIResponse(text) {
    try {
        const customKey = localStorage.getItem('pageflow_gemini_api_key');
        const apiKey = customKey ? customKey.trim() : "AQ.Ab8RN6L9gB869vbklk4fdc0DvaZAzWwbhlICq54VZpf4jvAEBg";
        const modelName = "gemini-2.5-flash";
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        const prompt = `You are a helpful reading assistant inside a PDF reader app. Your task is to summarize the following highlighted text. 
Please provide a clear, concise, and accurate summary or explanation of the text. 
If it's a short phrase, provide context or define it. If it's a longer passage, extract the key takeaways.
Do not include any robotic intros like "Here is a summary:". Just provide the core explanation directly.
Format with markdown where appropriate (like **bold** for key terms or bullet points for lists) to make it easy to read.

Highlighted Text:
"${text}"`;

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }]
            })
        });

        if (!response.ok) {
            let errDetails = `Status ${response.status}`;
            try {
                const errJson = await response.json();
                if (errJson.error && errJson.error.message) {
                    errDetails = errJson.error.message;
                }
            } catch (e) {}
            throw new Error(errDetails);
        }

        const data = await response.json();
        
        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content && data.candidates[0].content.parts.length > 0) {
           return data.candidates[0].content.parts[0].text;
        } else {
             throw new Error("Invalid response format from AI API");
        }

    } catch (error) {
        console.error("AI summarization error details:", error);
        throw error;
    }
}

async function typeWriterEffect(element, text) {
    element.classList.add('typewriter-cursor');
    let i = 0;
    const speed = 15; // ms per character

    return new Promise(resolve => {
        function type() {
            if (i < text.length) {
                // Handle newlines and basic markdown-like bolding for premium feel
                let char = text.charAt(i);
                if (char === '\n') {
                    element.innerHTML += '<br>';
                } else {
                    element.innerHTML += char;
                }
                
                // Real-time scrolling if content gets long
                element.parentElement.scrollTop = element.parentElement.scrollHeight;
                
                i++;
                setTimeout(type, speed);
            } else {
                element.classList.remove('typewriter-cursor');
                resolve();
            }
        }
        type();
    });
}

document.getElementById('ai-close-btn')?.addEventListener('click', () => {
    aiModal.style.display = 'none';
});

document.getElementById('ai-copy-btn')?.addEventListener('click', () => {
    const text = aiSummaryText.innerText;
    navigator.clipboard.writeText(text).then(() => {
        const icon = document.querySelector('#ai-copy-btn i');
        icon.className = 'fa fa-check';
        icon.style.color = '#10B981';
        setTimeout(() => {
            icon.className = 'fa fa-copy';
            icon.style.color = '';
        }, 2000);
    });
});



/* ================== HIGHLIGHTS VIEW ================== */
function loadHighlightsView() {
    const list = document.getElementById('highlights-list');
    list.innerHTML = '';

    if (state.highlights.length === 0) {
        list.innerHTML = '<div class="empty-state">No highlights yet.</div>';
    } else {
        // sort by newest
        const sorted = [...state.highlights].sort((a, b) => b.date - a.date);

        sorted.forEach(hl => {
            const card = document.createElement('div');
            card.className = 'hl-card';
            // Set border color based on chosen color
            let bColor = 'var(--primary-btn)';
            if (hl.color === 'yellow') bColor = '#FFD84F';
            if (hl.color === 'pink') bColor = '#FF4FA3';
            if (hl.color === 'blue') bColor = '#4F7CFF';
            if (hl.color === 'green') bColor = '#10B981';

            card.style.borderLeftColor = bColor;

            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <h5>${hl.bookTitle} (Page ${hl.page})</h5>
                    <button class="delete-hl-btn" data-id="${hl.id}" title="Delete Highlight">
                        <i class="fa fa-trash"></i>
                    </button>
                </div>
                <p>"${hl.text}"</p>
                <div class="meta">${new Date(hl.date).toLocaleDateString()}</div>
            `;

            // Handle delete action independently from opening the book
            const delBtn = card.querySelector('.delete-hl-btn');
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // prevent card click
                if (confirm("Are you sure you want to delete this highlight?")) {
                    state.highlights = state.highlights.filter(h => h.id !== hl.id);
                    localStorage.setItem('pageflow_highlights', JSON.stringify(state.highlights));
                    loadHighlightsView();
                }
            });

            card.addEventListener('click', () => {
                const book = state.books.find(b => b.id === hl.bookId);
                if (book) {
                    book.lastPage = hl.page; // temp jump to page
                    openBook(book);
                }
            });

            list.appendChild(card);
        });
    }
}

/* ================== PROFILE VIEW ================== */
function loadProfileView() {
    if (state.user) {
        const nameNode = document.getElementById('profile-name');
        if (nameNode) {
            nameNode.textContent = state.user.displayName || state.user.email.split('@')[0];
        }
        document.getElementById('profile-email').textContent = state.user.email;
    }

    document.getElementById('stat-books').textContent = state.books.length;
    document.getElementById('stat-highlights').textContent = state.highlights.length;
}

/* ================== INIT ================== */
async function initApp() {
    if (state.user) {
        loader.style.display = 'flex';
        try {
            await initIndexedDB();
            state.books = await getBooksFromIndexedDB(state.user.uid);
        } catch (e) {
            console.warn("Could not load offline books at startup", e);
        }
        loader.style.display = 'none';
        showView('view-home');
    } else {
        showView('view-login');
    }
}

/* ================== WINDOW RESIZE HANDLER (MOBILE FIT) ================== */
window.addEventListener('resize', () => {
    const isInReader = document.getElementById('view-reader')?.classList.contains('active');
    if (isInReader && state.pdfDoc && window.innerWidth < 768) {
        state.pdfDoc.getPage(state.pageNum).then(page => {
            const unscaledViewport = page.getViewport({ scale: 1.0 });
            let desiredWidth = window.innerWidth - 40;
            state.scale = desiredWidth / unscaledViewport.width;
            const zoomLvl = document.getElementById('zoom-level');
            if (zoomLvl) zoomLvl.textContent = Math.round(state.scale * 100) + '%';
            queueRenderPage(state.pageNum);
        });
    }
});

// Start
initApp();
