const express = require('express');
const http = require('http');
const { spawn, exec } = require('child_process');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

let dockerProcess = null; // Docker process instance
let clientContainers = {}; // Store containers per client
let inputBuffer = ''; // Buffer to store input

// Predefined test cases for grading
const testCases = [
  { input: "5\n", expectedOutput: "25\n" }, // Example: square number
  { input: "10\n", expectedOutput: "100\n" }
];

// Function to create a Docker container using Python
function createDockerContainer(socketId) {
  return new Promise((resolve, reject) => {
    exec("docker run -d --rm python:3.9-slim sleep infinity", (err, stdout) => {
      if (err) {
        console.error(`Error creating container: ${err.message}`);
        reject(err);
      } else {
        const id = stdout.trim(); // Container ID

        // Store the container ID under the client's socket ID
        if (!clientContainers[socketId]) {
          clientContainers[socketId] = [];
        }
        clientContainers[socketId].push(id);

        console.log(`Docker container created with ID: ${id} for client: ${socketId}`);
        resolve(id);
      }
    });
  });
}

// Function to clean up Docker containers after process completion or failure
function cleanUpDocker(containerId) {
  if (containerId) {
    exec(`docker stop ${containerId}`, (err) => {
      if (err) {
        console.error(`Error stopping container: ${err.message}`);
      } else {
        console.log(`Container ${containerId} stopped and cleaned up.`);
      }
    });
  }
}

// Function to clean up all containers for a specific client
function cleanUpClientContainers(socketId) {
  const containers = clientContainers[socketId];
  if (containers) {
    containers.forEach(containerId => cleanUpDocker(containerId));
    delete clientContainers[socketId]; // Remove client entry after cleaning up
  }
}

function runCodeInContainer(containerId, socket, code, isGrade = false) {
  const codeFilePath = path.join(__dirname, 'temp', `code_${containerId}.py`);
  fs.writeFileSync(codeFilePath, code); // Write user code to a file

  // Copy the Python code file into the Docker container
  exec(`docker cp ${codeFilePath} ${containerId}:/code.py`, (err) => {
    if (err) {
      console.error("Error copying code to container:", err.message);
      socket.emit("terminal-output", "Failed to copy code to container.");
      cleanUpDocker(containerId); // Ensure cleanup if copying fails
      return;
    }

    const startTime = new Date(); // Record start time

    if (isGrade) {
      // Sequentially run test cases in grading mode
      runTestCasesInContainer(containerId, socket, startTime);
    } else {
      // Normal execution in "Run" mode
      dockerProcess = spawn("docker", ["exec", "-i", containerId, "python3", "/code.py"]);

      let outputBuffer = ''; // Buffer for collecting stdout

      // Stream stdout (output from Python) to the frontend terminal
      dockerProcess.stdout.on("data", (data) => {
        const output = data.toString();
        outputBuffer += output;
        socket.emit("terminal-output", output);

        // Check if the script is requesting input from the user (non-grade mode)
        socket.emit("request-input", true); // Signal to the frontend that input is needed
      });

      // Stream stderr (errors or additional output) to the frontend terminal
      dockerProcess.stderr.on("data", (data) => {
        socket.emit("terminal-output", `Error: ${data.toString()}`);
      });

      // When the Docker process exits successfully
      dockerProcess.on("exit", (code) => {
        const endTime = new Date(); // Record end time
        const executionTime = (endTime - startTime) / 1000; // Calculate execution time in seconds
        cleanUpDocker(containerId);
        if (code === 0) {
          socket.emit("execution-result", `컴파일 성공! 실행 시간: ${executionTime}초.`);
        } else {
          socket.emit("execution-result", `컴파일 실패... 실행 시간: ${executionTime}초.`);
        }

        dockerProcess = null; // Reset the process
        socket.emit("enable-run-code"); // Re-enable the "Run Code" button
      });

      // Handle Docker process errors (e.g., killed, unexpected failure)
      dockerProcess.on("error", (err) => {
        console.error("Error during Docker process execution:", err.message);
        socket.emit("terminal-output", `Error: ${err.message}`);
        cleanUpDocker(containerId); // Cleanup Docker container in case of error
        socket.emit("enable-run-code"); // Re-enable the "Run Code" button
      });
    }
  });
}

// Sequential test case runner for grading mode
const MAX_EXECUTION_TIME = 1; // Maximum execution time in seconds for each test case

function runTestCasesInContainer(containerId, socket, startTime) {
  let passedCases = 0;
  let failedCases = 0;
  let currentTestIndex = 0; // Track current test case index

  function runNextTest() {
    if (currentTestIndex >= testCases.length) {
      const endTime = new Date();
      const totalExecutionTime = (endTime - startTime) / 1000;
      cleanUpDocker(containerId);
      socket.emit("terminal-output", `Grading Complete: ${passedCases} Passed, ${failedCases} Failed`);
      socket.emit("execution-result", `총 실행 시간: ${totalExecutionTime}초.`);
      
      socket.emit("enable-run-code"); // Re-enable the "Run Code" button
      return;
    }

    const testCase = testCases[currentTestIndex];
    const testStartTime = new Date(); // Start time for the current test case

    // Execute the Python script inside the Docker container
    dockerProcess = spawn("docker", ["exec", "-i", containerId, "python3", "/code.py"]);

    let outputBuffer = '';

    // Stream stdout (output from Python) to the frontend terminal
    dockerProcess.stdout.on("data", (data) => {
      const output = data.toString();
      outputBuffer += output;
      socket.emit("terminal-output", output);
    });

    // Stream stderr (errors or additional output) to the frontend terminal
    dockerProcess.stderr.on("data", (data) => {
      socket.emit("terminal-output", `Error: ${data.toString()}`);
    });

    // Send the input immediately for the current test case
    dockerProcess.stdin.write(testCase.input);

    // Set up a timeout to kill the process if it runs longer than 1 second
    const processTimeout = setTimeout(() => {
      socket.emit("terminal-output", `Test Case ${currentTestIndex + 1}: Failed (Execution time exceeded ${MAX_EXECUTION_TIME} second)\n`);
      dockerProcess.kill(); // Kill the process if it exceeds the maximum allowed execution time
      failedCases++;
      currentTestIndex++; // Move to the next test case
      runNextTest(); // Recursively run the next test case
    }, MAX_EXECUTION_TIME * 1000); // Convert to milliseconds

    // When the Docker process exits successfully
    dockerProcess.on("exit", (code) => {
      clearTimeout(processTimeout); // Clear the timeout if the process exits normally

      const testEndTime = new Date(); // End time for the current test case
      const testExecutionTime = (testEndTime - testStartTime) / 1000; // Calculate execution time in seconds

      if (testExecutionTime <= MAX_EXECUTION_TIME && outputBuffer.includes(testCase.expectedOutput)) {
        passedCases++;
        socket.emit("terminal-output", `Test Case ${currentTestIndex + 1}: Passed (Execution Time: ${testExecutionTime.toFixed(3)}s)\n`);
      } else if (testExecutionTime > MAX_EXECUTION_TIME) {
        socket.emit("terminal-output", `Test Case ${currentTestIndex + 1}: Failed (Timeout, Execution Time: ${testExecutionTime.toFixed(3)}s)\n`);
        failedCases++;
      } else {
        failedCases++;
        socket.emit("terminal-output", `Test Case ${currentTestIndex + 1}: Failed\n`);
      }

      currentTestIndex++; // Move to the next test case
      runNextTest(); // Recursively run the next test case
    });

    // Handle Docker process errors
    dockerProcess.on("error", (err) => {
      socket.emit("terminal-output", `Error: ${err.message}`);
      cleanUpDocker(containerId);
      socket.emit("enable-run-code"); // Re-enable the "Run Code" button
    });
  }

  runNextTest(); // Start the first test
}


io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on('run-code', async ({ code }) => {
    if (dockerProcess) {
      // Kill the existing docker process and clean up the container
      dockerProcess.kill(); 
      inputBuffer = ''; // Clear the input buffer when stopping the container
      await cleanUpDocker(containerId); // Cleanup existing Docker container
      dockerProcess = null; // Reset dockerProcess and containerId
      containerId = null;
    }
    try {
      socket.emit("clear-terminal"); // Clear the terminal before running new code
      containerId = await createDockerContainer(socket.id); // Store container by client
      runCodeInContainer(containerId, socket, code); // Run the code in "Run" mode
    } catch (error) {
      console.error("Error running code:", error);
      socket.emit("terminal-output", "Failed to run code.");
    }
  });

  socket.on('grade-code', async ({ code }) => {
    if (dockerProcess) {
      // Kill the existing docker process and clean up the container
      dockerProcess.kill(); 
      inputBuffer = ''; // Clear the input buffer when stopping the container
      await cleanUpDocker(containerId); // Cleanup existing Docker container
      dockerProcess = null; // Reset dockerProcess and containerId
      containerId = null;
    }
    try {
      socket.emit("clear-terminal"); // Clear the terminal before running new code
      containerId = await createDockerContainer(socket.id); // Store container by client
      runCodeInContainer(containerId, socket, code, true); // Run the code in "Grade" mode
    } catch (error) {
      console.error("Error grading code:", error);
      socket.emit("terminal-output", "Failed to grade code.");
    }
  });

  // Single send-input binding outside of run-code event to avoid duplication
  socket.on("send-input", (input) => {
    if (dockerProcess) {
      inputBuffer = input; // Update input buffer with the user input
      dockerProcess.stdin.write(input + "\n"); // Send user input to the Docker process
      socket.emit("request-input", false); // Disable input field after sending input
    }
  });

  // Handle stop-code event to terminate the running container
  socket.on('stop-code', async () => {
    if (dockerProcess) {
      dockerProcess.kill(); // Kill the running process
      inputBuffer = ''; // Clear the input buffer when stopping the container
      await cleanUpDocker(containerId); // Stop the container and clean up
      socket.emit("terminal-output", "Code execution stopped.\n");
      socket.emit("enable-run-code"); // Notify the client to re-enable the Run Code button
    }
  });

  // Clean up Docker container when the client disconnects
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    if (dockerProcess) {
      dockerProcess.kill(); // Kill the running process
    }
    cleanUpClientContainers(socket.id); // Ensure all containers for the client are cleaned up
  });
});

// Start the server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
