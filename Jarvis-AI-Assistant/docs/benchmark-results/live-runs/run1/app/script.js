document.addEventListener('DOMContentLoaded', () => {
  const STORAGE_KEY = 'todo_app_tasks';

  // DOM Elements
  const todoForm = document.getElementById('todo-form');
  const todoInput = document.getElementById('todo-input');
  const todoList = document.getElementById('todo-list');
  const emptyState = document.getElementById('empty-state');
  const emptyStateText = document.getElementById('empty-state-text');
  const taskCounter = document.getElementById('task-counter');
  const filterBtns = document.querySelectorAll('.filter-btn');
  const clearCompletedBtn = document.getElementById('clear-completed');

  // Application State
  let tasks = loadTasks();
  let currentFilter = 'all';

  // Helper Functions
  function loadTasks() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('Failed to load tasks from localStorage:', error);
      return [];
    }
  }

  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (error) {
      console.error('Failed to save tasks to localStorage:', error);
    }
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  }

  function addTask(title) {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    const newTask = {
      id: generateId(),
      title: trimmedTitle,
      completed: false,
      createdAt: Date.now()
    };

    tasks.unshift(newTask);
    saveTasks();
    render();
  }

  function toggleTask(id) {
    tasks = tasks.map(task => {
      if (task.id === id) {
        return { ...task, completed: !task.completed };
      }
      return task;
    });
    saveTasks();
    render();
  }

  function deleteTask(id) {
    tasks = tasks.filter(task => task.id !== id);
    saveTasks();
    render();
  }

  function clearCompleted() {
    tasks = tasks.filter(task => !task.completed);
    saveTasks();
    render();
  }

  function setFilter(filter) {
    currentFilter = filter;
    filterBtns.forEach(btn => {
      const isSelected = btn.getAttribute('data-filter') === filter;
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
    render();
  }

  function getFilteredTasks() {
    switch (currentFilter) {
      case 'active':
        return tasks.filter(task => !task.completed);
      case 'completed':
        return tasks.filter(task => task.completed);
      case 'all':
      default:
        return tasks;
    }
  }

  function updateCounter() {
    if (!taskCounter) return;
    const activeCount = tasks.filter(task => !task.completed).length;
    taskCounter.textContent = `${activeCount} ${activeCount === 1 ? 'item' : 'items'} left`;
  }

  function render() {
    if (!todoList) return;

    const filteredTasks = getFilteredTasks();
    todoList.innerHTML = '';

    if (filteredTasks.length === 0) {
      if (emptyState) {
        emptyState.classList.remove('hidden');
        if (emptyStateText) {
          if (tasks.length === 0) {
            emptyStateText.textContent = 'No tasks yet. Add one above!';
          } else if (currentFilter === 'active') {
            emptyStateText.textContent = 'No active tasks.';
          } else if (currentFilter === 'completed') {
            emptyStateText.textContent = 'No completed tasks.';
          } else {
            emptyStateText.textContent = 'No tasks found.';
          }
        }
      }
    } else {
      if (emptyState) {
        emptyState.classList.add('hidden');
      }

      filteredTasks.forEach(task => {
        const li = document.createElement('li');
        li.className = `todo-item${task.completed ? ' completed' : ''}`;
        li.dataset.id = task.id;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'todo-item-content';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'todo-checkbox';
        checkbox.checked = task.completed;
        checkbox.setAttribute(
          'aria-label',
          `Mark task "${task.title}" as ${task.completed ? 'incomplete' : 'complete'}`
        );

        const titleSpan = document.createElement('span');
        titleSpan.className = 'todo-title';
        titleSpan.textContent = task.title;

        contentDiv.appendChild(checkbox);
        contentDiv.appendChild(titleSpan);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-delete';
        deleteBtn.setAttribute('aria-label', `Delete task "${task.title}"`);
        deleteBtn.innerHTML = `
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
          </svg>
        `;

        li.appendChild(contentDiv);
        li.appendChild(deleteBtn);

        todoList.appendChild(li);
      });
    }

    updateCounter();
  }

  // Event Listeners
  if (todoForm) {
    todoForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (todoInput) {
        addTask(todoInput.value);
        todoInput.value = '';
        todoInput.focus();
      }
    });
  }

  if (todoList) {
    todoList.addEventListener('click', (e) => {
      const todoItem = e.target.closest('.todo-item');
      if (!todoItem) return;

      const id = todoItem.dataset.id;

      if (e.target.closest('.btn-delete')) {
        deleteTask(id);
      } else if (e.target.closest('.todo-checkbox')) {
        toggleTask(id);
      }
    });
  }

  if (clearCompletedBtn) {
    clearCompletedBtn.addEventListener('click', () => {
      clearCompleted();
    });
  }

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.getAttribute('data-filter');
      if (filter) {
        setFilter(filter);
      }
    });
  });

  // Initial Render
  render();
});
