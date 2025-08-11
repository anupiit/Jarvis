const { callGeminiAPI } = require('../services/geminiService');
const { log } = require('../utils/logger');

class ProjectPlanner {
  constructor() {
    this.currentProject = null;
  }

  async createProjectPlan(projectDescription) {
    log('\n🧠 AI Planning Phase Started...', 'magenta');
    log('━'.repeat(50), 'dim');

    const planningPrompt = `
You are an expert software architect. Create a detailed project plan for: "${projectDescription}"

Respond with a JSON object containing:
{
  "projectName": "kebab-case-name",
  "description": "Brief description",
  "features": ["feature1", "feature2", ...],
  "techStack": ["html", "css", "javascript"],
  "fileStructure": [
    {"name": "index.html", "type": "file", "fileType": "html", "description": "Main HTML file"},
    {"name": "styles.css", "type": "file", "fileType": "css", "description": "Styling"},
    {"name": "script.js", "type": "file", "fileType": "javascript", "description": "Main functionality"},
    {"name": "assets", "type": "directory", "description": "Static assets folder"},
    {"name": "components", "type": "directory", "description": "Reusable components"}
  ],
  "dependencies": ["any external libraries needed"],
  "architecture": "Brief explanation of how components work together"
}

For complex projects, include nested directory structures like:
{"name": "src/components/auth", "type": "directory", "description": "Authentication components"},
{"name": "src/components/auth/Login.js", "type": "file", "fileType": "javascript", "description": "Login component"}

Make it modern, responsive, and feature-complete. Focus on clean code and good UX.
`;

    try {
      const response = await callGeminiAPI(planningPrompt);
      const planMatch = response.match(/\{[\s\S]*\}/);
      
      if (planMatch) {
        this.currentProject = JSON.parse(planMatch[0]);
        this.displayPlan();
        return this.currentProject;
      } else {
        throw new Error('Could not parse project plan');
      }
    } catch (error) {
      log(`❌ Planning failed: ${error.message}`, 'red');
      return this.createFallbackPlan(projectDescription);
    }
  }

  createFallbackPlan(projectDescription) {
    const projectName = projectDescription.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    
    this.currentProject = {
      projectName,
      description: projectDescription,
      features: ["Core functionality", "Responsive design", "Modern UI"],
      techStack: ["html", "css", "javascript"],
      fileStructure: [
        {"name": "index.html", "type": "file", "fileType": "html", "description": "Main HTML file"},
        {"name": "styles.css", "type": "file", "fileType": "css", "description": "Styling"},
        {"name": "script.js", "type": "file", "fileType": "javascript", "description": "Main functionality"},
        {"name": "assets", "type": "directory", "description": "Static assets folder"}
      ],
      dependencies: [],
      architecture: "Simple single-page application"
    };

    log('📋 Using fallback plan...', 'yellow');
    this.displayPlan();
    return this.currentProject;
  }

  displayPlan() {
    const plan = this.currentProject;
    
    log('\n📋 PROJECT PLAN GENERATED', 'green');
    log('━'.repeat(50), 'dim');
    log(`📁 Project: ${plan.projectName}`, 'bright');
    log(`📝 Description: ${plan.description}`, 'white');
    
    log('\n✨ Features:', 'cyan');
    plan.features.forEach(feature => log(`  • ${feature}`, 'white'));
    
    log('\n🛠️ Tech Stack:', 'yellow');
    plan.techStack.forEach(tech => log(`  • ${tech.toUpperCase()}`, 'white'));
    
    log('\n📂 File Structure:', 'blue');
    plan.fileStructure.forEach(item => {
      const icon = item.type === 'directory' ? '📁' : '📄';
      log(`  ${icon} ${item.name} - ${item.description}`, 'white');
    });
    
    if (plan.dependencies.length > 0) {
      log('\n📦 Dependencies:', 'magenta');
      plan.dependencies.forEach(dep => log(`  • ${dep}`, 'white'));
    }
    
    log(`\n🏗️ Architecture: ${plan.architecture}`, 'green');
    log('━'.repeat(50), 'dim');
  }
}

module.exports = ProjectPlanner; 