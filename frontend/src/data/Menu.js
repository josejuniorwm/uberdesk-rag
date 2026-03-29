const dashboardMenu = [
  { "label": "Finance Monitoring", "link": "#", "icon": "ri-pie-chart-2-line" },
  { "label": "Events Management", "link": "#", "icon": "ri-calendar-todo-line" },
  { "label": "Sales Monitoring", "link": "#", "icon": "ri-shopping-bag-3-line" },
  { "label": "Website Analytics", "link": "#", "icon": "ri-bar-chart-2-line" },
  { "label": "Helpdesk Service", "link": "#", "icon": "ri-service-line" },
  { "label": "Storage Management", "link": "#", "icon": "ri-hard-drive-2-line" },
  { "label": "Product Management", "link": "#", "icon": "ri-suitcase-2-line" }
];

const applicationsMenu = [
  { "label": "Chat", "link": "/apps/chat", "icon": "ri-question-answer-line" },
  { "label": "Email", "link": "#", "icon": "ri-mail-send-line" },
  { "label": "Calendar", "link": "#", "icon": "ri-calendar-line" },
  { "label": "Contacts", "link": "#", "icon": "ri-contacts-book-line" },
  { "label": "Task Manager", "link": "#", "icon": "ri-checkbox-multiple-line" },
  {
    "label": "Media Gallery",
    "icon": "ri-gallery-line",
    "submenu": [
      { "label": "Music Stream", "link": "#" },
      { "label": "Video Stream", "link": "#" }
    ]
  }
];

const pagesMenu = [
  {
    "label": "User Pages",
    "icon": "ri-account-circle-line",
    "submenu": []
  },
  {
    "id": 27,
    "label": "Authentication",
    "icon": "ri-lock-2-line",
    "submenu": [
      { "label": "Sign In Basic", "link": "/pages/signin" }
    ]
  }
];

const uiElementsMenu = []; // Deixamos vazio mas declarado para não dar erro no export

export { dashboardMenu, applicationsMenu, pagesMenu, uiElementsMenu };