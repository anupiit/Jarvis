document.addEventListener('DOMContentLoaded', () => {
  const STORAGE_KEY = 'taskflow_tasks';

  // Safe DOM element retrieval
  const todoForm = document.getElementById('todo-form');
  const todoInput = document.getElementById('todo-input');
  const todoList = document.getElementById('todo-list');
  const emptyState = document.getElementById('empty-state');
  const taskCounter = document.getElementById('task-counter');
  const filterBtns = document.querySelectorAll('.filter-btn');
  const clearCompletedBtn = document.getElementById('clear-completed-btn');

  // Application State
  let tasks = loadTasks();
  let currentFilter = 'all';

  /**
   * Safely load tasks from browser localStorage
   * @returns {Array} List of stored task objects
   */
  function loadTasks() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return [];
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('Failed to parse tasks from localStorage:', e);
      return [];
    }
  }

  /**
   * Safely save current state to browser localStorage
   */
  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (e) {
      console.error('Failed to save tasks to localStorage:', e);
    }
  }

  /**
   * Generate a unique ID string for new task items
   * @returns {string} Unique identifier
   */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  }

  /**
   * Add a new task to state and synchronize storage and view
   * @param {string} text Task description text
   */
  function addTask(text) {
    const trimmedText = text.trim();
    if (!trimmedText) return;

    const newTask = {
      id: generateId(),
      text: trimmedText,
      completed: false,
      createdAt: Date.now()
    };

    tasks.unshift(newTask);
    saveTasks();
    render();
  }

  /**
   * Toggle completion status of a task by ID
   * @param {string} id Task ID
   */
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

  /**
   * Delete an individual task by ID
   * @param {string} id Task ID
   */
  function deleteTask(id) {
    tasks = tasks.filter(task => task.id !== id);
    saveTasks();
    render();
  }

  /**
   * Delete all tasks marked as completed
   */
  function clearCompleted() {
    tasks = tasks.filter(task => !task.completed);
    saveTasks();
    render();
  }

  /**
   * Filter task list based on currently active filter setting
   * @returns {Array} List of tasks matching current filter
   */
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

  /**
   * Update empty state container visibility and dynamic text
   * @param {number} totalCount Total tasks in state
   * @param {number} filteredCount Count of tasks matching filter
   */
  function renderEmptyState(totalCount, filteredCount) {
    if (!emptyState) return;

    if (filteredCount > 0) {
      emptyState.classList.add('hidden');
      return;
    }

    emptyState.classList.remove('hidden');

    const emptyTitle = emptyState.querySelector('.empty-title');
    const emptySubtitle = emptyState.querySelector('.empty-subtitle');

    if (totalCount === 0) {
      if (emptyTitle) emptyTitle.textContent = 'No tasks yet';
      if (emptySubtitle) emptySubtitle.textContent = 'Add a task above to get started!';
    } else if (currentFilter === 'active') {
      if (emptyTitle) emptyTitle.textContent = 'No active tasks';
      if (emptySubtitle) emptySubtitle.textContent = 'All caught up! Great job.';
    } else if (currentFilter === 'completed') {
      if (emptyTitle) emptyTitle.textContent = 'No completed tasks';
      if (emptySubtitle) emptySubtitle.textContent = 'Completed tasks will appear here.';
    } else {
      if (emptyTitle) emptyTitle.textContent = 'No tasks found';
      if (emptySubtitle) emptySubtitle.textContent = 'Try switching filters or adding a new task.';
    }
  }

  /**
   * Update stats counter and clear-completed button status
   */
  function renderControls() {
    const activeCount = tasks.filter(task => !task.completed).length;
    const completedCount = tasks.length - activeCount;

    if (taskCounter) {
      taskCounter.textContent = `${activeCount} item${activeCount === 1 ? '' : 's'} left`;
    }

    if (clearCompletedBtn) {
      if (completedCount > 0) {
        clearCompletedBtn.classList.remove('hidden');
      } else {
        clearCompletedBtn.classList.add('hidden');
      }
    }
  }

  /**
   * Construct DOM node for a single task item
   * @param {Object} task Task object
   * @returns {HTMLLIElement} Constructed LI element
   */
  function createTaskElement(task) {
    const li = document.createElement('li');
    li.className = `todo-item${task.completed ? ' completed' : ''}`;
    li.dataset.id = task.id;

    // Content container
    const contentDiv = document.createElement('div');
    contentDiv.className = 'task-content';

    // Checkbox input
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-checkbox';
    checkbox.checked = task.completed;
    checkbox.setAttribute('aria-label', `Mark "${task.text}" as ${task.completed ? 'active' : 'completed'}`);

    checkbox.addEventListener('change', () => {
      toggleTask(task.id);
    });

    // Task text label
    const textSpan = document.createElement('span');
    textSpan.className = 'task-text';
    textSpan.textContent = task.text;

    contentDiv.appendChild(checkbox);
    contentDiv.appendChild(textSpan);

    // Delete action button
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-btn';
    deleteBtn.setAttribute('aria-label', `Delete task "${task.text}"`);

    deleteBtn.innerHTML = `
      <svg class="delete-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
      </svg>
    `;

    deleteBtn.addEventListener('click', () => {
      deleteTask(task.id);
    });

    li.appendChild(contentDiv);
    li.appendChild(deleteBtn);

    return li;
  }

  /**
   * Render the entire application interface state
   */
  function render() {
    const filteredTasks = getFilteredTasks();

    if (todoList) {
      todoList.innerHTML = '';
      filteredTasks.forEach(task => {
        const itemElement = createTaskElement(task);
        todoList.appendChild(itemElement);
      });
    }

    renderEmptyState(tasks.length, filteredTasks.length);
    renderControls();
  }

  // --- Event Listeners ---

  // Task Form Submit Handler
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

  // Filter Buttons Click Handlers
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      currentFilter = btn.dataset.filter || 'all';

      render();
    });
  });

  // Clear Completed Button Click Handler
  if (clearCompletedBtn) {
    clearCompletedBtn.addEventListener('click', () => {
      clearCompleted();
    });
  }

  // Initial View Render
  render();
});
