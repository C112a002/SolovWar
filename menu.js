(() => {
  const aboutButton = document.querySelector(".about-item");
  const aboutDialog = document.querySelector("#about-dialog");
  const closeButton = document.querySelector(".dialog-close");
  const exitButton = document.querySelector(".exit-item");
  const notice = document.querySelector("#notice");
  let noticeTimer;

  function showNotice(message) {
    notice.textContent = message;
    notice.hidden = false;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 3800);
  }

  function closeAbout() {
    aboutDialog.hidden = true;
    aboutButton.focus();
  }

  aboutButton.addEventListener("click", () => {
    aboutDialog.hidden = false;
    closeButton.focus();
  });
  closeButton.addEventListener("click", closeAbout);
  aboutDialog.addEventListener("click", event => {
    if (event.target === aboutDialog) closeAbout();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !aboutDialog.hidden) closeAbout();
  });
  exitButton.addEventListener("click", () => {
    window.close();
    window.setTimeout(() => {
      if (!document.hidden) showNotice("瀏覽器不允許網頁關閉此分頁，請手動關閉分頁離開遊戲。");
    }, 120);
  });
})();
