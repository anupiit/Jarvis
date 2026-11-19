// Hand-written reference To-Do app used as deterministic "model output" in tests and to
// validate the browser verification script itself. It is NOT Gemini output.

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>To-Do List</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="app">
    <h1>To-Do List</h1>
    <form id="task-form" class="task-form">
      <label for="task-input" class="visually-hidden">New task</label>
      <input id="task-input" type="text" placeholder="Add a new task" autocomplete="off" required>
      <button id="add-button" type="submit">Add</button>
    </form>
    <ul id="task-list" class="task-list" aria-live="polite"></ul>
    <p id="empty-state" class="empty-state">No tasks yet.</p>
  </main>
  <script src="script.js" defer></script>
</body>
</html>`;

const STYLE_CSS = `:root {
  --accent: #4f46e5;
  --bg: #f5f5fb;
  --text: #1f2937;
  --done: #9ca3af;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
}

.app {
  max-width: 32rem;
  margin: 2rem auto;
  padding: 1rem;
}

.task-form {
  display: flex;
  gap: 0.5rem;
}

.task-form input {
  flex: 1;
  padding: 0.6rem;
}

.task-list {
  list-style: none;
  padding: 0;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
}

.task-item.completed .task-text {
  text-decoration: line-through;
  color: var(--done);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

@media (max-width: 480px) {
  .task-form { flex-direction: column; }
}`;

const SCRIPT_JS = `(function () {
  'use strict';
  var STORAGE_KEY = 'todo-list-app.tasks';
  var form = document.getElementById('task-form');
  var input = document.getElementById('task-input');
  var list = document.getElementById('task-list');
  var emptyState = document.getElementById('empty-state');
  if (!form || !input || !list) return;

  function load() {
    try {
      var data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  }

  var tasks = load();

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch (e) { /* storage unavailable */ }
  }

  function render() {
    list.innerHTML = '';
    tasks.forEach(function (task) {
      var li = document.createElement('li');
      li.className = 'task-item' + (task.completed ? ' completed' : '');
      li.dataset.id = task.id;

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = task.completed;
      checkbox.setAttribute('aria-label', 'Mark task as completed');
      checkbox.addEventListener('change', function () {
        task.completed = checkbox.checked;
        save();
        render();
      });

      var text = document.createElement('span');
      text.className = 'task-text';
      text.textContent = task.text;

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'delete-button';
      del.textContent = 'Delete';
      del.addEventListener('click', function () {
        tasks = tasks.filter(function (t) { return t.id !== task.id; });
        save();
        render();
      });

      li.append(checkbox, text, del);
      list.appendChild(li);
    });
    if (emptyState) emptyState.hidden = tasks.length > 0;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var value = input.value.trim();
    if (!value) return;
    tasks.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2), text: value, completed: false });
    input.value = '';
    save();
    render();
  });

  render();
})();`;

const TODO_REQUEST = 'Create a simple modern responsive To-Do List web application using HTML, CSS, and vanilla JavaScript. It must allow users to add tasks, display tasks, mark tasks as completed, delete tasks, and persist tasks in localStorage. Generate exactly three files: index.html, style.css, and script.js. Do not use React, Node.js, external libraries, databases, APIs, or additional folders.';

const TODO_BLUEPRINT = {
  projectName: 'todo-list-app',
  title: 'To-Do List',
  description: 'A responsive to-do list that stores tasks in localStorage.',
  features: ['Add tasks', 'Display tasks', 'Mark tasks as completed', 'Delete tasks', 'Persist tasks in localStorage'],
  techStack: ['HTML', 'CSS', 'JavaScript'],
  files: [
    { path: 'index.html', description: 'Markup' },
    { path: 'style.css', description: 'Styles' },
    { path: 'script.js', description: 'Logic' }
  ],
  directories: [],
  dependencies: [],
  architecture: 'index.html loads style.css and script.js.'
};

module.exports = { INDEX_HTML, STYLE_CSS, SCRIPT_JS, TODO_REQUEST, TODO_BLUEPRINT };
