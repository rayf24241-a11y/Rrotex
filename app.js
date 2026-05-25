const profileButton = document.querySelector('#profileButton');
const profileMenu = document.querySelector('#profileMenu');
const upgradeLink = document.querySelector('#upgradeLink');
const checkoutButton = document.querySelector('#checkoutButton');

function setProfileOpen(open) {
  profileMenu.classList.toggle('open', open);
  profileMenu.setAttribute('aria-hidden', String(!open));
  profileButton.setAttribute('aria-expanded', String(open));
}

profileButton.addEventListener('click', () => {
  setProfileOpen(!profileMenu.classList.contains('open'));
});

upgradeLink.addEventListener('click', () => {
  setProfileOpen(false);
});

document.addEventListener('click', (event) => {
  if (!profileMenu.contains(event.target) && !profileButton.contains(event.target)) {
    setProfileOpen(false);
  }
});

checkoutButton.addEventListener('click', () => {
  alert('Use Stripe test mode through a backend endpoint before going live.');
});
