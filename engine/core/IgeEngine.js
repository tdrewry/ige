/**
 * The base engine class definition.
 */
var IgeEngine = IgeEntity.extend({
	classId: 'IgeEngine',

	init: function () {
		this._super();
		this._id = 'ige';

		this.basePath = '';

		// Determine the environment we are executing in
		this.isServer = (typeof(module) !== 'undefined' && typeof(module.exports) !== 'undefined');

		// Assign ourselves to the global variable
		ige = this;

		// Output our header
		console.log('------------------------------------------------------------------------------');
		console.log('* Powered by the Isogenic Game Engine ' + version + '                                  *');
		console.log('* (C)opyright 2012 Irrelon Software Limited                                  *');
		console.log('* http://www.isogenicengine.com                                              *');
		console.log('------------------------------------------------------------------------------');

		// Call super-class method
		this._super();

		// Check if we should add the CocoonJS support component
		if (!this.isServer) {
			// Enable cocoonJS support because we are running native
			this.addComponent(IgeCocoonJsComponent);
		}

		// Create storage
		this.ClassStore = {};
		this.TextureStore = [];

		// Set the initial id as the current time in milliseconds. This ensures that under successive
		// restarts of the engine, new ids will still always be created compared to earlier runs -
		// which is important when storing persistent data with ids etc
		this._idCounter = new Date().getTime();

		// Setup components
		this.addComponent(IgeInputComponent);
		this.addComponent(IgeTweenComponent);

		// Set some defaults
		this.tickDelta = 0; // The time between the last tick and the current one
		this._fpsRate = 60; // Sets the frames per second to execute engine tick's at
		this._state = 0; // Currently stopped
		this._textureImageStore = {};
		this._texturesLoading = 0; // Holds a count of currently loading textures
		this._texturesTotal = 0; // Holds total number of textures loading / loaded
		this._dependencyQueue = []; // Holds an array of functions that must all return true for the engine to start
		this._drawCount = 0; // Holds the number of draws since the last frame (calls to drawImage)
		this._dps = 0; // Number of draws that occurred last tick
		this._frames = 0; // Number of frames looped through since last second tick
		this._fps = 0; // Number of frames per second
		this._clientNetDiff = 0; // The difference between the server and client comms (only non-zero on clients)
		this._frameAlternator = false; // Is set to the boolean not of itself each frame
		this._viewportDepth = false;
		this._mousePos = new IgePoint(0, 0, 0);
		this._register = {
			'ige': this
		}; // Holds a reference to every item in the scenegraph by it's ID

		if (this.isServer) {
			// Setup a dummy canvas context
			this.log('Using dummy canvas context');
			this._ctx = IgeDummyContext;
		}

		this.dependencyTimeout(30000); // Wait 30 seconds to load all dependencies then timeout

		// Add the textures loaded dependency
		this._dependencyQueue.push(this.texturesLoaded);
		this._dependencyQueue.push(this.canvasReady);

		// Start a timer to record every second of execution
		setInterval(this._secondTick, 1000);
	},

	/**
	 * Returns an object from the engine's object register by
	 * the object's id. If the item passed is not a string id
	 * then the item is returned as is. If no item is passed
	 * the engine itself is returned.
	 * @param item
	 */
	$: function (item) {
		if (typeof(item) === 'string') {
			return this._register[item];
		} else if (typeof(item) === 'object') {
			return item;
		}

		return this;
	},

	/**
	 * Returns an array of all obejects that have been assigned
	 * the passed group name.
	 * @param groupName
	 */
	$$: function (groupName) {
		//TODO
	},

	/**
	 * Register an object with the engine object register. The
	 * register allows you to access an object by it's id with
	 * a call to ige.$(objectId).
	 * @param obj
	 * @return {*}
	 */
	register: function (obj) {
		if (obj !== undefined) {
			if (!this._register[obj.id()]) {
				this._register[obj.id()] = obj;
				obj._registered = true;

				return this;
			} else {
				obj._registered = false;

				this.log('Cannot add object id "' + obj.id() + '" to scenegraph because there is already another object in the graph with the same ID!', 'error');
				return false;
			}
		}

		return this._register;
	},

	unRegister: function (obj) {
		if (obj !== undefined) {
			if (this._register[obj.id()]) {
				delete this._register[obj.id()];
				obj._registered = false;
			}
		}

		return this;
	},

	/**
	 * Sets the frame rate at which new engine ticks are fired.
	 * Setting this rate will override the default requestAnimFrame()
	 * method as defined in IgeBase.js and on the client-side, will
	 * stop usage of any available requestAnimationFrame() method
	 * and will use a setTimeout()-based version instead.
	 * @param {Number} fpsRate
	 */
	setFps: function (fpsRate) {
		if (fpsRate !== undefined) {
			// Override the default requestAnimFrame handler and set
			// our own method up so that we can control the frame rate
			if (this.isServer) {
				// Server-side implementation
				requestAnimFrame = function(callback, element){
					setTimeout(callback, 1000 / fpsRate);
				};
			} else {
				// Client-side implementation
				window.requestAnimFrame = function(callback, element){
					setTimeout(callback, 1000 / fpsRate);
				};
			}
		}
	},

	/**
	 * Defines a class in the engine's class repository.
	 * @param {String} id The unique class ID or name.
	 * @param {Object} obj The class definition.
	 */
	defineClass: function (id, obj) {
		ige.ClassStore[id] = obj;
	},

	/**
	 * Retrieves a class by it's ID that was defined with
	 * a call to defineClass().
	 * @param {String} id The ID of the class to retrieve.
	 * @return {Object} The class definition.
	 */
	getClass: function (id) {
		return ige.ClassStore[id];
	},

	/**
	 * Generates a new instance of a class defined with a call
	 * to the defineClass() method. Passes the options
	 * parameter to the new class during it's constructor call.
	 * @param id
	 * @param options
	 * @return {*}
	 */
	newClassInstance: function (id, options) {
		return new ige.ClassStore[id](options);
	},

	/**
	 * Checks if all engine start dependencies have been satisfied.
	 * @return {Boolean}
	 */
	dependencyCheck: function () {
		var arr = this._dependencyQueue,
			arrCount = arr.length;

		while (arrCount--) {
			if (!this._dependencyQueue[arrCount]()) {
				return false;
			}
		}

		return true;
	},

	/**
	 * Gets / sets the flag that determines if viewports should be sorted by depth
	 * like regular entities, before they are processed for rendering each frame.
	 * Depth-sorting viewports increases processing requirements so if you do not
	 * need to stack viewports in a particular order, keep this flag false.
	 * @param {Boolean} val
	 * @return {Boolean}
	 */
	viewportDepth: function (val) {
		if (val !== undefined) {
			this._viewportDepth = val;
			return this;
		}

		return this._viewportDepth;
	},

	/**
	 * Sets the number of milliseconds before the engine gives up waiting for dependencies
	 * to be satisfied and cancels the startup procedure.
	 * @param val
	 */
	dependencyTimeout: function (val) {
		this._dependencyCheckTimeout = val;
	},

	/**
	 * Adds one to the number of textures currently loading.
	 */
	textureLoadStart: function () {
		this._texturesLoading++;
		this._texturesTotal++;
		this.emit('textureLoadStart');
	},

	/**
	 * Subtracts one from the number of textures currently loading and if no more need
	 * to load, it will also call the _allTexturesLoaded() method.
	 */
	textureLoadEnd: function (url, textureObj) {
		// Add the texture to the TextureStore array
		this.TextureStore.push(textureObj);

		// Decrement the overall loading number
		this._texturesLoading--;
		this.emit('textureLoadEnd');

		// If we've finished...
		if (this._texturesLoading === 0) {
			// All textures have finished loading
			this._allTexturesLoaded();
		}
	},

	/**
	 * Returns a texture from the texture store by it's url.
	 * @param {String} url
	 * @return {IgeTexture}
	 */
	textureFromUrl: function (url) {
		var arr = this.TextureStore,
			arrCount = arr.length,
			item;

		while (arrCount--) {
			item = arr[arrCount];
			if (item._url === url) {
				return item;
			}
		}
	},

	/**
	 * Checks if all textures have finished loading and returns true if so.
	 * @return {Boolean}
	 */
	texturesLoaded: function () {
		return ige._texturesLoading === 0;
	},

	/**
	 * Emits the "texturesLoaded" event.
	 * @private
	 */
	_allTexturesLoaded: function () {
		this.log('All textures have loaded');

		// Fire off an event about this
		this.emit('texturesLoaded');
	},

	/**
	 * Checks to ensure that a canvas has been assigned to the engine or that the
	 * engine is in server mode.
	 * @return {Boolean}
	 */
	canvasReady: function () {
		return (ige._canvas !== undefined || ige.isServer);
	},

	/**
	 * Generates a new unique ID
	 * @return {String}
	 */
	newId: function () {
		this._idCounter++;
		return String(this._idCounter + (Math.random() * Math.pow(10, 17) + Math.random() * Math.pow(10, 17) + Math.random() * Math.pow(10, 17) + Math.random() * Math.pow(10, 17)));
	},

	/**
	 * Generates a new 16-character hexadecimal unique ID
	 * @return {String}
	 */
	newIdHex: function () {
		this._idCounter++;
		return (this._idCounter + (Math.random() * Math.pow(10, 17) + Math.random() * Math.pow(10, 17) + Math.random() * Math.pow(10, 17) + Math.random() * Math.pow(10, 17))).toString(16);
	},

	/**
	 * Starts the engine.
	 * @param callback
	 */
	start: function (callback) {
		if (!ige._state) {
			// Check if we are able to start based upon any registered dependencies
			if (ige.dependencyCheck()) {
				// Start the engine
				ige.log('Starting engine...');
				ige._state = 1;

				requestAnimFrame(ige.tick);

				ige.log('Engine started');

				// Fire the callback method if there was one
				if (typeof(callback) === 'function') {
					callback(true);
				}
			} else {
				// Get the current timestamp
				var curTime = new Date().getTime();

				// Record when we first started checking for dependencies
				if (!ige._dependencyCheckStart) {
					ige._dependencyCheckStart = curTime;
				}

				// Check if we have timed out
				if (curTime - ige._dependencyCheckStart > this._dependencyCheckTimeout) {
					this.log('Engine start failed because the dependency check timed out after ' + (this._dependencyCheckTimeout / 1000) + ' seconds', 'error');
					if (typeof(callback) === 'function') {
						callback(false);
					}
				} else {
					// Start a timer to keep checking dependencies
					setTimeout(function () { ige.start(callback); }, 200);
				}
			}
		}
	},

	/**
	 * Stops the engine.
	 * @return {Boolean}
	 */
	stop: function () {
		// If we are running, stop the engine
		if (this._state) {
			this.log('Stopping engine...');
			this._state = 0;

			return true;
		} else {
			return false;
		}
	},

	/**
	 * Gets / sets the _autoSize property. If set to true, the engine will listen
	 * for any change in screen size and resize the front-buffer (canvas) element
	 * to match the new screen size.
	 * @param val
	 * @return {Boolean}
	 */
	autoSize: function (val) {
		if (typeof(val) !== 'undefined') {
			this._autoSize = val;
			return this;
		}

		return this._autoSize;
	},

	/**
	 * Automatically creates a canvas element, appends it to the document.body
	 * and sets it's 2d context as the current front-buffer for the engine.
	 * @param autoSize
	 */
	createFrontBuffer: function (autoSize) {
		if (!this.isServer) {
			if (!this._canvas) {
				// Create a new canvas element to use as the
				// rendering front-buffer
				var tempCanvas = document.createElement('canvas');
				tempCanvas.id = 'igeFrontBuffer';
				tempCanvas.width = window.innerWidth;
				tempCanvas.height = window.innerHeight;
				//tempCanvas.style.cssText = "idtkscale:ScaleAspectFit;";

				ige.geometry = new IgePoint(window.innerWidth, window.innerHeight, 0);

				this.canvas(tempCanvas, autoSize);
				document.body.appendChild(tempCanvas);
			}
		}
	},

	/**
	 * Sets the canvas element that will be used as the front-buffer.
	 * @param elem
	 * @param autoSize
	 */
	canvas: function (elem, autoSize) {
		if (!this._canvas) {
			// Setup front-buffer canvas element
			this._canvas = elem;
			this._ctx = this._canvas.getContext('2d');

			if (autoSize) {
				this._autoSize = autoSize;

				// Add some event listeners
				window.addEventListener('resize', this._resizeEvent);

				// Fire the resize event
				this._resizeEvent();
			}

			// Ask the input component to setup any listeners it has
			this.input._setupListeners();
		}
	},

	/**
	 * Clears the entire canvas.
	 */
	clearCanvas: function () {
		// Clear the whole canvas
		this._ctx.clearRect(
			0,
			0,
			this._canvas.width,
			this._canvas.height
		);
	},

	/**
	 * Opens a new window to the specified url. When running in a
	 * native wrapper, will load the url in place of any existing
	 * page being displayed in the native web view.
	 * @param url
	 */
	openUrl: function (url) {
		if (url !== undefined) {

			if (ige.cocoonJs && ige.cocoonJs.detected) {
				// Open URL via CocoonJS webview
				ige.cocoonJs.openUrl(url);
			} else {
				// Open via standard JS open window
				window.open(url);
			}
		}
	},

	/**
	 * Loads the specified URL as an HTML overlay on top of the
	 * front buffer in an iFrame. If running in a native wrapper,
	 * will load the url in place of any existing page being
	 * displayed in the native web view.
	 *
	 * When the overlay is in use, no mouse or touch events will
	 * be fired on the front buffer. Once you are finished with the
	 * overlay, call hideOverlay() to re-enable interaction with
	 * the front buffer.
	 * @param {String=} url
	 */
	showWebView: function (url) {
		if (ige.cocoonJs && ige.cocoonJs.detected) {
			// Open URL via CocoonJS webview
			ige.cocoonJs.showWebView(url);
		} else {
			// Load the iFrame url
			var overlay = document.getElementById('igeOverlay');

			if (!overlay) {
				// No overlay was found, create one
				overlay = document.createElement('iframe');

				// Setup overlay styles
				overlay.id = 'igeOverlay';
				overlay.style.position = 'absolute';
				overlay.style.border = 'none';
				overlay.style.left = '0px';
				overlay.style.top = '0px';
				overlay.style.width = '100%';
				overlay.style.height = '100%';

				// Append overlay to body
				document.body.appendChild(overlay);
			}

			// If we have a url, set it now
			if (url !== undefined) {
				overlay.src = url;
			}

			// Show the overlay
			overlay.style.display = 'block';
		}

		return this;
	},

	/**
	 * Hides the web view overlay.
	 * @return {*}
	 */
	hideWebView: function () {
		if (ige.cocoonJs && ige.cocoonJs.detected) {
			// Hide the cocoonJS webview
			ige.cocoonJs.hideWebView();
		} else {
			var overlay = document.getElementById('igeOverlay');
			if (overlay) {
				overlay.style.display = 'none';
			}
		}

		return this;
	},

	/**
	 * Evaluates javascript sent from another frame.
	 * @param js
	 */
	layerCall: function (js) {
		if (js !== undefined) {
			eval(js);
		}
	},

	/**
	 * Returns the mouse position relative to the main front buffer.
	 * @return {IgePoint}
	 */
	mousePos: function () {
		return this._mousePos;
	},

	/**
	 * Handles the screen resize event.
	 * @param event
	 * @private
	 */
	_resizeEvent: function (event) {
		if (ige._autoSize) {

			var newWidth = window.innerWidth,
				newHeight = window.innerHeight,
				arr = ige._children,
				arrCount = arr.length;

			// Make sure we can divide the new width and height by 2...
			// otherwise minus 1 so we get an even number so that we
			// negate the blur effect of sub-pixel rendering
			if (newWidth % 2) { newWidth--; }
			if (newHeight % 2) { newHeight--; }

			ige._canvas.width = newWidth;
			ige._canvas.height = newHeight;
			ige.geometry = new IgePoint(newWidth, newHeight, 0);

			// Loop any mounted children and check if
			// they should also get resized
			while (arrCount--) {
				arr[arrCount]._resizeEvent(event);
			}
		}
	},

	/**
	 * Is called every second and does things like calculate the current FPS.
	 * @private
	 */
	_secondTick: function () {
		// Store frames per second
		ige._fps = ige._frames;

		// Store draws per second
		ige._dps = ige._dpt * ige._fps;

		// Zero out counters
		ige._frames = 0;
		ige._drawCount = 0;
	},

	/**
	 * Called each frame to traverse and render the scenegraph.
	 */
	tick: function (timeStamp, ctx) {
		if (ige._state) {
			// Check if we were passed a context to work with
			if (ctx === undefined) {
				ctx = ige._ctx;
			}

			// Schedule a new frame
			requestAnimFrame(ige.tick);

			// Alternate the boolean frame alternator flag
			ige._frameAlternator = !ige._frameAlternator;

			// Get the current time in milliseconds
			ige.tickStart = timeStamp;

			// Adjust the tickStart value by the difference between
			// the server and the client clocks (this is only applied
			// when running as the client - the server always has a
			// clientNetDiff of zero)
			ige.tickStart -= ige._clientNetDiff;

			if (!ige.lastTick) {
				// This is the first time we've run so set some
				// default values and set the delta to zero
				ige.lastTick = 0;
				ige.tickDelta = 0;
			} else {
				// Calculate the frame delta
				ige.tickDelta = ige.tickStart - ige.lastTick;
			}

			// Process any behaviours assigned to the engine
			ige._processBehaviours(ctx);

			// Render the scenegraph
			ige.render(ctx);

			// Record the lastTick value so we can
			// calculate delta on the next tick
			ige.lastTick = ige.tickStart;
			ige._frames++;
			ige._dpt = ige._drawCount;
			ige._drawCount = 0;

			// Call the input system tick to reset any flags etc
			ige.input.tick();
		}
	},

	render: function (ctx, scene) {
		// Depth-sort the viewports
		if (this._viewportDepth) {
			this.depthSortChildren();
		}

		ctx.save();
		ctx.translate(this.geometry.x2, this.geometry.y2);

		// Process the current engine tick for all child objects
		var arr = this._children,
			arrCount = arr.length;

		// Loop our viewports and call their tick methods
		while (arrCount--) {
			ctx.save();
				arr[arrCount].tick(ctx, scene);
			ctx.restore();
		}

		ctx.restore();
	},

	/**
	 * Walks the scene graph and outputs a console map of the graph.
	 */
	sceneGraph: function (obj, currentDepth, lastDepth) {
		if (currentDepth === undefined) { currentDepth = 0; }

		if (!obj) {
			// Set the obj to the main ige instance
			obj = ige;
		}

		var depthSpace = '', di;
		for (di = 0; di < currentDepth; di++) {
			depthSpace += '    ';
		}

		console.log(depthSpace + obj.id() + ' (' + obj._classId + ')');

		currentDepth++;

		if (obj === ige) {
			// Loop the viewports
			var arr = obj._children,
				arrCount;

			if (arr) {
				arrCount = arr.length;

				// Loop our children
				while (arrCount--) {
					if (arr[arrCount]._scene._shouldRender) {
						console.log(depthSpace + '    ' + arr[arrCount].id() + ' (' + arr[arrCount]._classId + ')');
						this.sceneGraph(arr[arrCount]._scene, currentDepth + 1);
					}
				}
			}
		} else {
			var arr = obj._children,
				arrCount;

			if (arr) {
				arrCount = arr.length;

				// Loop our children
				while (arrCount--) {
					this.sceneGraph(arr[arrCount], currentDepth);
				}
			}
		}
	},

	/**
	 * Walks the scenegraph and returns a data object of the graph.
	 */
	getSceneGraphData: function (obj) {
		var item, items = [], tempItem, tempItem2, tempItems,
			arr, arrCount;

		if (!obj) {
			// Set the obj to the main ige instance
			obj = ige;
		}

		item = {
			text: obj.id() + ' (' + obj._classId + ')',
			parent: obj._parent,
			id: obj.id()
		};

		if (obj === ige) {
			// Loop the viewports
			arr = obj._children;

			if (arr) {
				arrCount = arr.length;

				// Loop our children
				while (arrCount--) {
					tempItem = {
						text: arr[arrCount].id() + ' (' + arr[arrCount]._classId + ')',
						parent: arr[arrCount]._parent,
						id: arr[arrCount].id()
					};

					if (arr[arrCount]._scene) {
						tempItem2 = this.getSceneGraphData(arr[arrCount]._scene);
						tempItem.items = [tempItem2];
					}

					items.push(tempItem);
				}
			}
		} else {
			arr = obj._children;

			if (arr) {
				arrCount = arr.length;

				// Loop our children
				while (arrCount--) {
					tempItem = this.getSceneGraphData(arr[arrCount]);
					items.push(tempItem);
				}
			}
		}

		if (items.length > 0) {
			item.items = items;
		}

		return item;
	}
});

if (typeof(module) !== 'undefined' && typeof(module.exports) !== 'undefined') { module.exports = IgeEngine; }