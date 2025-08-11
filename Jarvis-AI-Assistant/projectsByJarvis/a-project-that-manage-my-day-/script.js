/**
 * script.js
 * Purpose: Main functionality for the day management project.
 * Features: Core functionality, Responsive design, Modern UI.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // --- Constants and Variables ---
  const taskInput = document.getElementById('taskInput');
  const addTaskButton = document.getElementById('addTaskButton');
  const taskList = document.getElementById('taskList');
  const clearCompletedButton = document.getElementById('clearCompleted');
  const themeToggleButton = document.getElementById('themeToggle');
  const body = document.body;
  let tasks = [];

  // --- Helper Functions ---
  const debounce = (func, delay) => {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), delay);
    };
  };

  const generateUniqueId = () => {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  };

  // --- Theme Management ---
  const loadTheme = () => {
    const theme = localStorage.getItem('theme') || 'light';
    body.classList.toggle('dark-mode', theme === 'dark');
    themeToggleButton.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  };

  const toggleTheme = () => {
    body.classList.toggle('dark-mode');
    const newTheme = body.classList.contains('dark-mode') ? 'dark' : 'light';
    localStorage.setItem('theme', newTheme);
    themeToggleButton.textContent = newTheme === 'dark' ? 'Light Mode' : 'Dark Mode';
  };

  // --- Task Management Functions ---
  const loadTasks = () => {
    try {
      const storedTasks = localStorage.getItem('tasks');
      tasks = storedTasks ? JSON.parse(storedTasks) : [];
      renderTasks();
    } catch (error) {
      console.error("Error loading tasks:", error);
      displayMessage("Error loading tasks. Please try again.", 'error');
    }
  };

  const saveTasks = () => {
    try {
      localStorage.setItem('tasks', JSON.stringify(tasks));
    } catch (error) {
      console.error("Error saving tasks:", error);
      displayMessage("Error saving tasks. Please try again.", 'error');
    }
  };

  const addTask = () => {
    const taskText = taskInput.value.trim();
    if (!taskText) {
      displayMessage("Task cannot be empty.", 'warning');
      return;
    }

    const newTask = {
      id: generateUniqueId(),
      text: taskText,
      completed: false,
      createdAt: new Date().toISOString(),
    };

    tasks.push(newTask);
    saveTasks();
    renderTasks();
    taskInput.value = '';
    displayMessage("Task added successfully!", 'success');
  };

  const toggleComplete = (id) => {
    tasks = tasks.map(task =>
      task.id === id ? { ...task, completed: !task.completed } : task
    );
    saveTasks();
    renderTasks();
  };

  const deleteTask = (id) => {
    tasks = tasks.filter(task => task.id !== id);
    saveTasks();
    renderTasks();
    displayMessage("Task deleted.", 'info');
  };

  const clearCompletedTasks = () => {
    tasks = tasks.filter(task => !task.completed);
    saveTasks();
    renderTasks();
    displayMessage("Completed tasks cleared.", 'info');
  };

  const renderTasks = () => {
    taskList.innerHTML = ''; // Clear existing list

    if (tasks.length === 0) {
      taskList.innerHTML = '<li class="empty-state">No tasks yet. Add some!</li>';
      return;
    }

    tasks.forEach(task => {
      const listItem = document.createElement('li');
      listItem.classList.add('task-item');
      listItem.innerHTML = `
        <input type="checkbox" id="task-${task.id}" data-id="${task.id}" ${task.completed ? 'checked' : ''}>
        <label for="task-${task.id}" class="${task.completed ? 'completed' : ''}">${task.text}</label>
        <button class="delete-button" data-id="${task.id}">Delete</button>
      `;
      taskList.appendChild(listItem);
    });
  };

  // --- Message Display ---
  const displayMessage = (message, type = 'info') => {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', `message-${type}`);
    messageDiv.textContent = message;
    document.body.appendChild(messageDiv);

    setTimeout(() => {
      messageDiv.remove();
    }, 3000); // Remove after 3 seconds
  };

  // --- Event Listeners ---
  addTaskButton.addEventListener('click', addTask);

  taskInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      addTask();
    }
  });

  taskList.addEventListener('change', (event) => {
    if (event.target.type === 'checkbox') {
      const id = event.target.dataset.id;
      toggleComplete(id);
    }
  });

  taskList.addEventListener('click', (event) => {
    if (event.target.classList.contains('delete-button')) {
      const id = event.target.dataset.id;
      deleteTask(id);
    }
  });

  clearCompletedButton.addEventListener('click', clearCompletedTasks);

  themeToggleButton.addEventListener('click', toggleTheme);

  window.addEventListener('resize', debounce(() => {
    // Handle responsive design changes here, if needed.
    console.log('Window resized');
  }, 250));

  // --- Initialization ---
  loadTheme();
  loadTasks();
});