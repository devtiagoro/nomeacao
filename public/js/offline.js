const retry = () => location.reload();
document.getElementById('retry').addEventListener('click', retry);
window.addEventListener('online', retry);
