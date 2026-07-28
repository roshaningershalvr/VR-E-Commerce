'use strict';

const formatINR = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
let currentUser = null;
let cartItems = [];

const modal = document.querySelector('[data-modal]');
const modalCloseBtn = document.querySelector('[data-modal-close]');
const modalCloseOverlay = document.querySelector('[data-modal-overlay]');
const notificationToast = document.querySelector('[data-toast]');
const toastCloseBtn = document.querySelector('[data-toast-close]');
const mobileMenuOpenBtn = document.querySelectorAll('[data-mobile-menu-open-btn]');
const mobileMenu = document.querySelectorAll('[data-mobile-menu]');
const mobileMenuCloseBtn = document.querySelectorAll('[data-mobile-menu-close-btn]');
const overlay = document.querySelector('[data-overlay]');
const accordionBtn = document.querySelectorAll('[data-accordion-btn]');
const accordion = document.querySelectorAll('[data-accordion]');
const searchField = document.querySelector('.search-field');
const searchButton = document.querySelector('.search-btn');
const headerActionButtons = document.querySelectorAll('.header-user-actions .action-btn');
const mobileActionButtons = document.querySelectorAll('.mobile-bottom-navigation .action-btn');
const favoriteCountElements = document.querySelectorAll('.action-btn .count');

function setupBaseInteractions() {
  if (modal && modalCloseBtn && modalCloseOverlay) {
    const modalCloseFunc = () => modal.classList.add('closed');
    modalCloseOverlay.addEventListener('click', modalCloseFunc);
    modalCloseBtn.addEventListener('click', modalCloseFunc);
  }

  if (notificationToast && toastCloseBtn) {
    toastCloseBtn.addEventListener('click', () => notificationToast.classList.add('closed'));
  }

  for (let i = 0; i < mobileMenuOpenBtn.length; i += 1) {
    const mobileMenuCloseFunc = () => {
      if (mobileMenu[i]) mobileMenu[i].classList.remove('active');
      if (overlay) overlay.classList.remove('active');
    };
    mobileMenuOpenBtn[i].addEventListener('click', () => {
      if (mobileMenu[i]) mobileMenu[i].classList.add('active');
      if (overlay) overlay.classList.add('active');
    });
    if (mobileMenuCloseBtn[i]) mobileMenuCloseBtn[i].addEventListener('click', mobileMenuCloseFunc);
    if (overlay) overlay.addEventListener('click', mobileMenuCloseFunc);
  }

  for (let i = 0; i < accordionBtn.length; i += 1) {
    accordionBtn[i].addEventListener('click', function onAccordionClick() {
      const target = this.nextElementSibling;
      const isOpen = target && target.classList.contains('active');
      for (let j = 0; j < accordion.length; j += 1) {
        if (!isOpen && accordion[j].classList.contains('active')) {
          accordion[j].classList.remove('active');
          if (accordionBtn[j]) accordionBtn[j].classList.remove('active');
        }
      }
      if (target) target.classList.toggle('active');
      this.classList.toggle('active');
    });
  }
}

function convertUsdToInr() {
  const exchangeRate = 83;
  document.querySelectorAll('.price, del, .old-price').forEach(el => {
    const text = el.textContent.trim();
    if (!text.includes('$')) return;
    const usd = Number.parseFloat(text.replace('$', '').trim());
    if (!Number.isNaN(usd)) el.textContent = formatINR(Math.round(usd * exchangeRate));
  });
}

function parsePrice(rawValue) {
  return Number(String(rawValue || '').replace(/[^\d]/g, '')) || 0;
}

function updateCartCount() {
  const totalQty = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const cartCountNodes = [
    ...document.querySelectorAll('.header-user-actions .action-btn:nth-child(3) .count'),
    ...document.querySelectorAll('.mobile-bottom-navigation .action-btn:nth-child(2) .count')
  ];
  cartCountNodes.forEach(node => {
    node.textContent = String(totalQty);
  });
}

function createAuthAndCartUI() {
  const controls = document.createElement('div');
  controls.id = 'auth-cart-controls';
  controls.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:9999;display:flex;gap:8px;flex-wrap:wrap;';
  controls.innerHTML = `
    <button id="auth-button" style="padding:10px 14px;border:none;border-radius:6px;background:#212121;color:#fff;cursor:pointer;">Login</button>
    <button id="checkout-button" style="padding:10px 14px;border:none;border-radius:6px;background:#0f9d58;color:#fff;cursor:pointer;">Checkout</button>
  `;
  document.body.appendChild(controls);
}

async function api(path, options = {}) {
  const csrfToken = document.cookie
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('csrf_token='))
    ?.split('=')[1];
  const method = (options.method || 'GET').toUpperCase();
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': decodeURIComponent(csrfToken) } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function ensureAuthenticated() {
  if (currentUser) return true;
  const choice = window.prompt('Type "r" to register or "l" to login', 'l');
  if (!choice) return false;
  const email = window.prompt('Email');
  const password = window.prompt('Password (min 6 chars)');
  if (!email || !password) return false;
  try {
    if (choice.toLowerCase() === 'r') {
      const name = window.prompt('Full name', 'Customer');
      const res = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name: name || 'Customer', email, password })
      });
      currentUser = res.user;
      alert(`Welcome, ${currentUser.name}`);
      return true;
    }
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    currentUser = res.user;
    alert(`Welcome back, ${currentUser.name}`);
    return true;
  } catch (error) {
    alert(error.message);
    return false;
  }
}

function collectProductFromButton(button) {
  const showcase = button.closest('.showcase');
  const titleNode = showcase?.querySelector('.showcase-title');
  const categoryNode = showcase?.querySelector('.showcase-category');
  const imageNode = showcase?.querySelector('img');
  const priceNode = showcase?.querySelector('.price');
  return {
    name: (titleNode?.textContent || 'Product').trim(),
    category: (categoryNode?.textContent || 'General').trim(),
    image: imageNode?.getAttribute('src') || null,
    price_inr: parsePrice(priceNode?.textContent)
  };
}

async function loadCart() {
  if (!currentUser) return;
  try {
    const res = await api('/api/cart');
    cartItems = res.items || [];
    updateCartCount();
  } catch {
    cartItems = [];
    updateCartCount();
  }
}

function bindAuthButton() {
  const authButton = document.getElementById('auth-button');
  if (!authButton) return;

  const refreshLabel = () => {
    authButton.textContent = currentUser ? `Logout (${currentUser.name.split(' ')[0]})` : 'Login';
  };
  refreshLabel();

  authButton.addEventListener('click', async () => {
    if (currentUser) {
      await api('/api/auth/logout', { method: 'POST' });
      currentUser = null;
      cartItems = [];
      updateCartCount();
      refreshLabel();
      return;
    }
    const ok = await ensureAuthenticated();
    if (ok) {
      await loadCart();
      refreshLabel();
    }
  });
}

function bindCartButtons() {
  const addToCartButtons = [
    ...document.querySelectorAll('.add-cart-btn'),
    ...Array.from(document.querySelectorAll('.btn-action')).filter(btn => btn.querySelector('ion-icon[name="bag-add-outline"]'))
  ];

  addToCartButtons.forEach(button => {
    button.addEventListener('click', async event => {
      event.preventDefault();
      const isAuthed = await ensureAuthenticated();
      if (!isAuthed) return;
      const product = collectProductFromButton(button);
      if (!product.price_inr) {
        alert('Unable to detect product price.');
        return;
      }
      try {
        await api('/api/cart/items', {
          method: 'POST',
          body: JSON.stringify({ quantity: 1, product })
        });
        await loadCart();
        alert(`${product.name} added to cart`);
      } catch (error) {
        alert(error.message);
      }
    });
  });
}

async function checkout() {
  const isAuthed = await ensureAuthenticated();
  if (!isAuthed) return;
  await loadCart();
  if (!cartItems.length) {
    alert('Your cart is empty.');
    return;
  }
  const shipping_name = window.prompt('Shipping name');
  const shipping_address = window.prompt('Shipping address');
  if (!shipping_name || !shipping_address) return;
  try {
    const res = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ shipping_name, shipping_address })
    });
    alert(`Order #${res.order_id} placed successfully for ${formatINR(res.total_inr)}.`);
    await loadCart();
  } catch (error) {
    alert(error.message);
  }
}

function bindCheckoutButton() {
  const checkoutButton = document.getElementById('checkout-button');
  if (!checkoutButton) return;
  checkoutButton.addEventListener('click', checkout);
}

function bindSearch() {
  if (!searchField || !searchButton) return;
  const runSearch = () => {
    const term = searchField.value.trim().toLowerCase();
    document.querySelectorAll('.product-grid .showcase').forEach(card => {
      const title = (card.querySelector('.showcase-title')?.textContent || '').toLowerCase();
      const category = (card.querySelector('.showcase-category')?.textContent || '').toLowerCase();
      card.style.display = !term || title.includes(term) || category.includes(term) ? '' : 'none';
    });
  };
  searchButton.addEventListener('click', runSearch);
  searchField.addEventListener('keydown', e => {
    if (e.key === 'Enter') runSearch();
  });
}

async function bootstrap() {
  setupBaseInteractions();
  convertUsdToInr();
  createAuthAndCartUI();
  bindSearch();
  bindCartButtons();
  bindCheckoutButton();
  favoriteCountElements.forEach(node => {
    if (!node.textContent.trim()) node.textContent = '0';
  });

  try {
    const me = await api('/api/auth/me');
    currentUser = me.user;
  } catch {
    currentUser = null;
  }

  bindAuthButton();
  await loadCart();

  if (headerActionButtons[2]) headerActionButtons[2].addEventListener('click', e => { e.preventDefault(); checkout(); });
  if (mobileActionButtons[1]) mobileActionButtons[1].addEventListener('click', e => { e.preventDefault(); checkout(); });
}

bootstrap();