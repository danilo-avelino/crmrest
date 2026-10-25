// O ícone da extensão abre o painel lateral do agente de implantação e suporte (panel.html).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
