import { FLAG_PATH, MODULE_ID, SYSTEM_PATH } from "./constants.js";
import { getSimpleQuestFlag, setSimpleQuestFlag } from "./flags.js";
import { getSetting } from "./settings.js";

export class MapImage {
    constructor(src, page, multiSource, lockPins) {
        this.src = src;
        this.page = page;
        this.multiSource = multiSource;
        this._lockPins = lockPins;
        this.isMultiSource = multiSource.length > 1;
        this.element = document.createElement("div");
        this.element.classList.add("simple-quest-map-image");
        this.element.style.overflow = "hidden";
        this.element.style.position = "relative";
        this.element.style.width = "100%";
        this.element.style.height = "100%";
        this.element.style.setProperty("--zoom-level", 1);
        this.element.style.cursor = this.grabCursor;
        this.element.style.maskImage = "linear-gradient(rgba(0, 0, 0, 0) 0%, black 10%, black 90%, rgba(0, 0, 0, 0) 100%), linear-gradient(to right, rgba(0, 0, 0, 0) 0%, black 10%, black 90%, rgba(0, 0, 0, 0) 100%)";
        this.element.style.webkitMaskImage = "linear-gradient(rgba(0, 0, 0, 0) 0%, black 10%, black 90%, rgba(0, 0, 0, 0) 100%), linear-gradient(to right, rgba(0, 0, 0, 0) 0%, black 10%, black 90%, rgba(0, 0, 0, 0) 100%)";
        this.element.style.webkitMaskComposite = "source-in";
        this.element.style.opacity = 0;
        this.aspectRatio = 1;
        this._exploredPolygon = getSimpleQuestFlag(this.page, "fogOfWar") ?? [];
        this._fowMaskImage = getSimpleQuestFlag(this.page, "fowMask") || null;
        this.create();
        this.initMarkers();
        this._loadPosition();
        //log estimated size in KB of the _exploredPolygon array
        const size = JSON.stringify(this._exploredPolygon).length / 1000;
        console.log(`Estimated size of fog of war for ${this.page.name}: ${size} KB`);
    }

    get grabCursor() {
        return "grab";
    }

    get grabCursorActive() {
        return "grabbing";
    }

    addCircleFogOfWar(radius = 0.1, c, subtract = false) {
        if (!game.user.isGM) return;
        const polygonPoints = [];
        radius *= this.fowBrushSize / 100;
        const nPoints = Math.max(8, radius * 200);
        const center = this.mousePositionToRelative(c.x, c.y);

        //if the FOW width and height are different, the circle will be an ellipse

        const width = this.FoWSize.width;
        const height = this.FoWSize.height;
        const aspectRatio = width / height;

        for (let i = 0; i < nPoints; i++) {
            const angle = (i * 2 * Math.PI) / nPoints;
            const x = center.x + radius * Math.cos(angle);
            const y = center.y + radius * Math.sin(angle) * aspectRatio;
            polygonPoints.push({ x, y });
        }

        const currentExploredPolygon = this._exploredPolygon;

        //create a clipper polygon from the points

        const clipper = new ClipperLib.Clipper();
        const clipperPolygon = new ClipperLib.Path();
        for (const point of polygonPoints) {
            clipperPolygon.push(new ClipperLib.IntPoint(parseInt(point.x * this.FoWSize.width), parseInt(point.y * this.FoWSize.height)));
        }

        if (currentExploredPolygon) {
            //union the current polygon with the new polygon
            clipper.AddPath(clipperPolygon, subtract ? ClipperLib.PolyType.ptClip : ClipperLib.PolyType.ptSubject, true);
            currentExploredPolygon.forEach((path) => {
                clipper.AddPath(path.path, subtract ? ClipperLib.PolyType.ptSubject : ClipperLib.PolyType.ptClip, true);
            });
            const solutionPaths = new ClipperLib.PolyTree();
            const mode = subtract ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctUnion;
            clipper.Execute(mode, solutionPaths, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

            const allPolygons = solutionPaths.m_AllPolys.map((poly) => {
                return { path: poly.m_polygon, isHole: poly.IsHole() };
            });
            this._exploredPolygon = allPolygons;
        } else {
            //union the current polygon with itself
            clipper.AddPath(clipperPolygon, ClipperLib.PolyType.ptSubject, true);
            clipper.AddPath(clipperPolygon, ClipperLib.PolyType.ptClip, true);
            const solutionPaths = new ClipperLib.PolyTree();
            clipper.Execute(ClipperLib.ClipType.ctUnion, solutionPaths, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
            const allPolygons = solutionPaths.m_AllPolys.map((poly) => {
                return { path: poly.m_polygon, isHole: poly.IsHole() };
            });
            this._exploredPolygon = allPolygons;
        }

        //sort by area so that the largest polygon is first

        this._exploredPolygon = this._exploredPolygon.sort((a, b) => {
            a.area ??= Math.abs(ClipperLib.Clipper.Area(a.path));
            b.area ??= Math.abs(ClipperLib.Clipper.Area(b.path));
            if (a.area < b.area) return 1;
        });

        this._exploredPolygon.forEach((polygon) => delete polygon.area);

        this.updateFoWSVG();
        this._fowNeedsSaving = true;
    }

    updateFoWSVG() {
        if (this._fowMaskImage) return this.updateFoWSVGWithImage();
        //remove the old SVG
        const oldSVG = this.image.querySelector("svg");
        if (oldSVG) oldSVG.remove();
        //convert clipper polygon to SVG polygon
        const polygon = this._exploredPolygon;
        if (!polygon) return;
        //the clipper polygon can have multiple paths and holes
        const svgContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svgContainer.style.width = "100%";
        svgContainer.style.height = "100%";
        svgContainer.style.filter = "blur(5px)";
        svgContainer.style.mixBlendMode = "multiply";
        svgContainer.style.position = "absolute";
        svgContainer.style.pointerEvents = "none";
        svgContainer.style.opacity = game.user.isGM ? 0.7 : 1;
        svgContainer.setAttribute("viewBox", `0 0 ${this.FoWSize.width} ${this.FoWSize.height}`);
        svgContainer.setAttribute("preserveAspectRatio", "none");
        this.image.appendChild(svgContainer);

        //draw a rectangle to cover the whole image
        const svgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        svgRect.setAttribute("x", 0);
        svgRect.setAttribute("y", 0);
        svgRect.setAttribute("width", this.FoWSize.width);
        svgRect.setAttribute("height", this.FoWSize.height);
        svgRect.setAttribute("fill", "white");
        svgContainer.appendChild(svgRect);

        for (const path of polygon) {
            const svgPolygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");

            for (const point of path.path) {
                const svgPoint = svgContainer.createSVGPoint();
                svgPoint.x = point.X;
                svgPoint.y = point.Y;
                svgPolygon.points.appendItem(svgPoint);
            }
            svgPolygon.setAttribute("fill", path.isHole ? "white" : "black");

            svgContainer.appendChild(svgPolygon);
        }

        this._svgFow = svgContainer;
        this.setFOWBlur();
    }

    updateFoWSVGWithImage() {
        //remove the old SVG
        const oldSVG = this.image.querySelector("svg");
        if (oldSVG) oldSVG.remove();
        //convert clipper polygon to SVG polygon
        const polygon = this._exploredPolygon;
        if (!polygon) return;
        //the clipper polygon can have multiple paths and holes
        const svgContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");

        svgContainer.style.width = "100%";
        svgContainer.style.height = "100%";
        svgContainer.style.position = "absolute";
        svgContainer.style.pointerEvents = "none";
        svgContainer.style.opacity = game.user.isGM ? 0.7 : 1;
        svgContainer.setAttribute("viewBox", `0 0 ${this.FoWSize.width} ${this.FoWSize.height}`);
        svgContainer.setAttribute("preserveAspectRatio", "none");
        this.image.appendChild(svgContainer);

        //draw a rectangle to cover the whole image
        const svgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        svgRect.setAttribute("x", 0);
        svgRect.setAttribute("y", 0);
        svgRect.setAttribute("width", this.FoWSize.width);
        svgRect.setAttribute("height", this.FoWSize.height);
        svgRect.setAttribute("fill", "black");

        const maskElement = document.createElementNS("http://www.w3.org/2000/svg", "mask");
        maskElement.setAttribute("id", "fow-mask");
        //set mask element to the same size as the svg
        maskElement.setAttribute("x", 0);
        maskElement.setAttribute("y", 0);
        maskElement.setAttribute("width", this.FoWSize.width);
        maskElement.setAttribute("height", this.FoWSize.height);
        svgContainer.appendChild(maskElement);

        maskElement.appendChild(svgRect);

        for (const path of polygon) {
            const svgPolygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");

            for (const point of path.path) {
                const svgPoint = svgContainer.createSVGPoint();
                svgPoint.x = point.X;
                svgPoint.y = point.Y;
                svgPolygon.points.appendItem(svgPoint);
            }
            svgPolygon.setAttribute("fill", path.isHole ? "black" : "white");

            maskElement.appendChild(svgPolygon);
        }

        //add image to mask
        const svgImage = document.createElementNS("http://www.w3.org/2000/svg", "image");
        svgImage.setAttribute("href", this._fowMaskImage);
        svgImage.setAttribute("width", this.FoWSize.width);
        svgImage.setAttribute("height", this.FoWSize.height);
        svgImage.setAttribute("preserveAspectRatio", "none");
        svgImage.setAttribute("mask", "url(#fow-mask)");
        svgContainer.appendChild(svgImage);

        this._svgFow = svgContainer;
        this.setFOWBlur();
    }

    setFOWBlur() {
        if (!this._svgFow) return;
        this._svgFow.style.filter = `blur(${Math.max(1.5, Math.min(this._zoomLevel ?? 1, 5))}px)`;
    }

    saveFoW() {
        if (!this._fowNeedsSaving) return;
        this._fowNeedsSaving = false;
        const polygon = this._exploredPolygon;
        if (!polygon) return;
        setSimpleQuestFlag(this.page, "fogOfWar", polygon);
    }

    resetFow() {
        Dialog.confirm({
            title: game.i18n.localize(`${MODULE_ID}.resetFow.title`),
            content: game.i18n.localize(`${MODULE_ID}.resetFow.content`),
            yes: () => {
                const fow = [
                    {
                        isHole: false,
                        path: [
                            { X: 0, Y: 0 },
                            { X: this.FoWSize.width, Y: 0 },
                            { X: this.FoWSize.width, Y: this.FoWSize.height },
                            { X: 0, Y: this.FoWSize.height },
                        ],
                    },
                ];
                setSimpleQuestFlag(this.page, "fogOfWar", fow);
                this._exploredPolygon = fow;
            },
            no: () => {
                return;
            },
            defaultYes: false,
        });
    }

    mousePositionToRelative(x, y) {
        const imageBoundingRect = this.image.getBoundingClientRect();
        x -= imageBoundingRect.left;
        y -= imageBoundingRect.top;
        const xPercent = x / imageBoundingRect.width;
        const yPercent = y / imageBoundingRect.height;
        return { x: xPercent, y: yPercent };
    }

    async preloadFowMask() {
        if (!this._fowMaskImage) return;
        const img = new Image();
        img.src = this._fowMaskImage;
        if (img.complete) return;
        await new Promise((resolve) => (img.onload = resolve));
    }

    create() {
        const image = document.createElement("div");
        image.style.backgroundImage = `url('${this.src}')`;
        image.style.backgroundSize = "contain";
        image.style.backgroundPosition = "center";
        image.style.overflow = "hidden";
        const img = new Image();
        img.src = this.src;
        img.style.opacity = 0;
        image.style.position = "absolute";
        this.image = image;
        this.image.appendChild(img);

        this.loadMultiSource();

        let isDown = false;
        let isRightDown = false;
        let startX;
        let startY;
        let startImgX;
        let startImgY;
        let imgX = 0;
        let imgY = 0;
        let hasZoomed = false;
        let originalWidth = 0;
        let originalHeight = 0;
        let currentZoom = 1;

        const onLoadedImage = () => {
            this.preloadFowMask().then(() => {
                this.element.style.opacity = 1;
            });
            this.aspectRatio = img.naturalWidth / img.naturalHeight;
            this.FoWSize = { width: img.naturalWidth, height: img.naturalHeight };
            this.updateFoWSVG();
            const width = this.element.offsetWidth || window.innerWidth * 0.5;
            this.image.style.width = width + "px";
            this.image.style.height = width / this.aspectRatio + "px";
            this.image.style.maxWidth = "unset";
            this.image.style.maxHeight = "unset";
            const loaded = this._loadPosition();
            img.remove();

            const doAsync = async () => {
                let imageBoundingRect = this.image.getBoundingClientRect();

                //wait for the image to have a width and height
                while (!imageBoundingRect.width || !imageBoundingRect.height) {
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    imageBoundingRect = this.image.getBoundingClientRect();
                }

                const elementBoundingRect = this.element.getBoundingClientRect();
                const bWidth = imageBoundingRect.width;
                const bHeight = imageBoundingRect.height;
                const elementWidth = elementBoundingRect.width;
                const elementHeight = elementBoundingRect.height;
                const widthScale = elementWidth / bWidth;
                const heightScale = elementHeight / bHeight;
                const scale = Math.min(widthScale, heightScale);
                originalHeight = bHeight * scale;
                originalWidth = bWidth * scale;

                if (loaded) {
                    imgX = loaded.imgX ?? 0;
                    imgY = loaded.imgY ?? 0;
                    this.setMultiSourceVisibility(originalWidth, originalHeight, loaded.width, loaded.height);
                } else {
                    //set the image so it fits withing this.element
                    this.image.style.width = bWidth * scale + "px";
                    this.image.style.height = bHeight * scale + "px";
                    this.image.style.left = (elementWidth - bWidth * scale) / 2 + "px";
                    this.image.style.top = (elementHeight - bHeight * scale) / 2 + "px";
                    imgX = (elementWidth - bWidth * scale) / 2;
                    imgY = (elementHeight - bHeight * scale) / 2;
                }
            };

            doAsync();
        };
        this.element.appendChild(image);

        if (!img.complete) img.onload = onLoadedImage;
        else onLoadedImage(); //setTimeout(onLoadedImage, 1);

        //create listeners to move the image withing the container by dragging

        image.addEventListener("mouseup", this._addMarker.bind(this));

        const markerPreview = document.createElement("div");
        markerPreview.classList.add("simple-quest-marker");
        markerPreview.style.position = "absolute";
        const i = document.createElement("i");
        i.classList.add("fas", "fa-location-dot");
        markerPreview.appendChild(i);
        markerPreview.style.transform = "translate(-50%, -50%)";
        markerPreview.style.color = "red";
        markerPreview.style.pointerEvents = "none";

        const brushPreview = document.createElement("div");
        brushPreview.style.position = "absolute";
        brushPreview.style.borderRadius = "50%";
        brushPreview.style.pointerEvents = "none";
        brushPreview.style.transform = "translate(-50%, -50%)";
        brushPreview.style.border = "2px dashed";
        brushPreview.style.zIndex = 100;
        brushPreview.style.boxShadow = "0 0 5px var(--simple-quest-background), 0 0 5px var(--simple-quest-background), 0 0 5px var(--simple-quest-background), 0 0 5px var(--simple-quest-background), 0 0 5px var(--simple-quest-background), inset 0 0 5px var(--simple-quest-background), inset 0 0 5px var(--simple-quest-background), inset 0 0 5px var(--simple-quest-background), inset 0 0 5px var(--simple-quest-background), inset 0 0 5px var(--simple-quest-background)";
        //black to transparent radial gradient
        //brushPreview.style.background = "radial-gradient(circle, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.7) 60%, rgba(0,0,0,0) 65%, rgba(0,0,0,0) 100%)";
        brushPreview.style.display = "none";

        const rulerAnchor = document.createElement("div");
        rulerAnchor.style.position = "absolute";
        rulerAnchor.style.transform = "translate(-50%, -85%)";
        rulerAnchor.style.pointerEvents = "none";
        rulerAnchor.style.zIndex = 100;
        rulerAnchor.style.display = "none";
        rulerAnchor.style.fontSize = "3vh";
        rulerAnchor.className = "simple-quest-ruler-anchor";
        rulerAnchor.innerHTML = `<i class="fas fa-map-pin"></i>`;
        this._rulerAnchor = rulerAnchor;

        const mouseTooltip = document.createElement("div");
        mouseTooltip.style.position = "absolute";
        mouseTooltip.style.transform = "translate(-50%, -100%)";
        mouseTooltip.style.pointerEvents = "none";
        mouseTooltip.style.zIndex = 100000;
        mouseTooltip.style.fontSize = "3vh";
        mouseTooltip.classList.add("simple-quest-pointer-tooltip");

        const rulerLine = document.createElement("div");
        rulerLine.style.position = "absolute";
        rulerLine.style.pointerEvents = "none";
        rulerLine.style.height = "3px";
        rulerLine.style.background = "var(--simple-quest-text-1)";
        rulerLine.style.transformOrigin = "left center";
        rulerLine.style.boxShadow = "0 0 5px var(--simple-quest-background), 0 0 5px var(--simple-quest-background), 0 0 5px var(--simple-quest-background), 0 0 5px var(--simple-quest-background)";
        rulerLine.style.borderRadius = "5px";

        rulerLine.style.width = "100%";
        rulerLine.style.zIndex = 50;

        this.image.appendChild(brushPreview);

        this.element.addEventListener("mousedown", (e) => {
            const isShiftDown = e.shiftKey;
            const isLeftClick = e.button === 0;
            const isCtrlDown = e.ctrlKey;

            if (isCtrlDown) {
                this.image.appendChild(rulerAnchor);
                this.image.appendChild(rulerLine);
                document.body.appendChild(mouseTooltip);
                rulerAnchor.style.display = "block";
                rulerAnchor._enabled = true;
                const imageBoundingRect = this.image.getBoundingClientRect();
                //get percent of the image
                const xPercent = (e.pageX - imageBoundingRect.left) / imageBoundingRect.width;
                const yPercent = (e.pageY - imageBoundingRect.top) / imageBoundingRect.height;
                rulerAnchor.dataset.leftPercent = xPercent;
                rulerAnchor.dataset.topPercent = yPercent;

                rulerAnchor.style.left = xPercent * 100 + "%";
                rulerAnchor.style.top = yPercent * 100 + "%";
            }

            if (isLeftClick) {
                isDown = this.page.isOwner;
                if (isShiftDown) return;
                !!!this._movingMarker && this.image.appendChild(markerPreview);
            } else {
                isRightDown = true;
                if (isShiftDown) return;
                this.element.style.cursor = this.grabCursorActive;
                startX = e.pageX - this.element.offsetLeft;
                startY = e.pageY - this.element.offsetTop;
                startImgX = imgX;
                startImgY = imgY;
                this._savePosition();
            }
        });

        this.element.addEventListener("mouseleave", () => {
            isDown = false;
            isRightDown = false;
            markerPreview.remove();
            rulerAnchor.remove();
            rulerLine.remove();
            rulerAnchor._enabled = false;
            mouseTooltip.remove();
            this.element.style.cursor = this.grabCursor;
            this._savePosition();
        });

        this.element.addEventListener("mouseup", () => {
            isDown = false;
            isRightDown = false;
            markerPreview.remove();
            rulerAnchor.remove();
            rulerLine.remove();
            rulerAnchor._enabled = false;
            mouseTooltip.remove();
            this.element.style.cursor = this.grabCursor;
            this._savePosition();
            this.saveFoW();
        });

        this.element.addEventListener("mousemove", (e) => {
            const isShiftDown = e.shiftKey;
            const isCtrlDown = e.ctrlKey;

            this.element.classList.toggle("prevent-icon-interaction", isCtrlDown);

            const imageBoundingRect = this.image.getBoundingClientRect();
            //get percent of the image
            const xPercent = (e.pageX - imageBoundingRect.left) / imageBoundingRect.width;
            const yPercent = (e.pageY - imageBoundingRect.top) / imageBoundingRect.height;

            if (game.user.isGM) {
                if (isShiftDown) {
                    brushPreview.style.left = xPercent * 100 + "%";
                    brushPreview.style.top = yPercent * 100 + "%";
                    brushPreview.style.width = this.fowBrushSize * 0.2 + "%";
                    brushPreview.style.height = this.fowBrushSize * 0.2 * this.aspectRatio + "%";
                    brushPreview.style.display = "block";
                    this.element.style.cursor = "none";
                } else {
                    brushPreview.style.display = "none";
                    if (this.element.style.cursor == "none") this.element.style.cursor = this.grabCursor;
                }
            }

            if (isShiftDown && (isDown || isRightDown)) {
                this.addCircleFogOfWar(0.1, { x: e.pageX, y: e.pageY }, isRightDown);
                return;
            }

            if (isDown && !this._movingMarker && !rulerAnchor._enabled) {
                e.preventDefault();
                const imageBoundingRect = this.image.getBoundingClientRect();
                const x = e.pageX - imageBoundingRect.left;
                const y = e.pageY - imageBoundingRect.top;

                markerPreview.style.left = x + "px";
                markerPreview.style.top = y + "px";
                this.element.style.cursor = "none";
            }

            if (this._movingMarker) {
                e.preventDefault();
                this._movingMarker.style.left = xPercent * 100 + "%";
                this._movingMarker.style.top = yPercent * 100 + "%";
                this._movingMarker.dataset.leftPercent = xPercent;
                this._movingMarker.dataset.topPercent = yPercent;
            }

            if (rulerAnchor._enabled) {
                const deltaX = xPercent - parseFloat(rulerAnchor.dataset.leftPercent);
                const deltaY = yPercent - parseFloat(rulerAnchor.dataset.topPercent);

                const pxX = deltaX * img.naturalWidth;
                const pxY = deltaY * img.naturalHeight;

                const angle = Math.atan2(pxY, pxX);

                const pxDistance = Math.sqrt(pxX * pxX + pxY * pxY);

                const percentDistance = pxDistance / img.naturalWidth;

                const units = (pxDistance * (this._measure / 100)).toFixed(2) + " " + this._measureUnits + ".";

                rulerLine.style.width = percentDistance * 100 + "%";
                rulerLine.style.left = parseFloat(rulerAnchor.dataset.leftPercent) * 100 + "%";
                rulerLine.style.top = parseFloat(rulerAnchor.dataset.topPercent) * 100 + "%";

                rulerLine.style.transformOrigin = "left center";

                rulerLine.style.transform = `rotate(${angle}rad)`;

                mouseTooltip.innerHTML = `<i class="fas fa-ruler"></i> ${units}`;
                mouseTooltip.style.left = e.pageX + "px";
                mouseTooltip.style.top = e.pageY + "px";
                this.element.style.cursor = "pointer";
            }

            if (!isRightDown || rulerAnchor._enabled) return;
            e.preventDefault();
            const x = e.pageX - this.element.offsetLeft;
            const y = e.pageY - this.element.offsetTop;

            //position the image

            const deltaX = x - startX;
            const deltaY = y - startY;

            imgX = startImgX + deltaX;
            imgY = startImgY + deltaY;

            image.style.left = imgX + "px";
            image.style.top = imgY + "px";
        });

        //on scroll zoom in and out

        const onWheel = (e, force = false) => {
            e.preventDefault();
            const scale = Math.min(Math.max(0.1, 1 + (e.deltaY ?? 1) * -0.001), 4);

            if (e.shiftKey) {
                const deltaSign = -1 * Math.sign(e.deltaY);
                this._fowBrushSizeInput.value = parseInt(this._fowBrushSizeInput.value) + deltaSign * 5;
                this._fowBrushSizeInput.dispatchEvent(new Event("change"));
                brushPreview.style.width = this.fowBrushSize * 0.2 + "%";
                brushPreview.style.height = this.fowBrushSize * 0.2 * this.aspectRatio + "%";
                return;
            }

            const image = this.image;

            //adjust the height and width of the image and position the image so that the cursor is in the same position
            const originalAspect = this.aspectRatio;
            const boundingRect = image.getBoundingClientRect();
            const oldWidth = boundingRect.width;
            const oldHeight = boundingRect.height;

            if (!hasZoomed && !originalWidth && !originalHeight) {
                originalWidth = oldWidth;
                originalHeight = oldHeight;
                hasZoomed = true;
            }

            const newWidth = oldWidth * scale;
            const newHeight = newWidth / originalAspect;

            this._zoomLevel = newWidth / originalWidth;

            this.setFOWBlur();

            if (this._zoomLevel < 0.7 || this._zoomLevel > 20) return;

            this.element.style.setProperty("--zoom-level", this._zoomLevel);

            if(force) return;

            const cursorXPercent = (e.pageX - boundingRect.left) / oldWidth;
            const cursorYPercent = (e.pageY - boundingRect.top) / oldHeight;

            //set the new width and height
            image.style.width = newWidth + "px";
            image.style.height = newHeight + "px";

            const deltaX = (newWidth - oldWidth) * cursorXPercent;
            const deltaY = (newHeight - oldHeight) * cursorYPercent;

            imgX -= deltaX;
            imgY -= deltaY;

            image.style.left = imgX + "px";
            image.style.top = imgY + "px";

            this._savePosition();

            this.setMultiSourceVisibility(originalWidth, originalHeight, newWidth, newHeight);
        };

        setTimeout(() => {
            onWheel(new MouseEvent("wheel", { deltaY: 10 }), true);
        }, 1);

        this.element.addEventListener("wheel", onWheel);

        this.element.addEventListener("drop", async (e) => {
            try {
                const imageBoundingRect = this.image.getBoundingClientRect();
                const xPercent = (e.pageX - imageBoundingRect.left) / imageBoundingRect.width;
                const yPercent = (e.pageY - imageBoundingRect.top) / imageBoundingRect.height;
                const isAlt = e.altKey;
                const dragData = JSON.parse(e.dataTransfer.getData("text/plain"));
                let title = "New Marker";
                let icon = "fas fa-location-dot";
                let uuid = dragData.uuid;
                const image = dragData?.texture?.src;
                if (uuid) {
                    const doc = await fromUuid(uuid);
                    title = doc.name ?? doc.title ?? "New Marker";
                    icon = doc.img ?? "fas fa-location-dot";
                    if (dragData.anchor) {
                        title.value = dragData.anchor.name;
                        uuid += "#" + dragData.anchor.slug;
                    }
                }
                if (image) {
                    icon = image;
                }
                const markersData = getSimpleQuestFlag(this.page, "markers") ?? {};
                const id = foundry.utils.randomID();
                markersData[id] = { title, icon, x: xPercent, y: yPercent, journal: uuid, hidden: isAlt, color: "#ff0000" };
                setSimpleQuestFlag(this.page, "markers", markersData);
            } catch (e) {}
        });
    }

    _savePosition() {
        const left = this.image.style.left;
        const top = this.image.style.top;
        const width = this.image.style.width;
        const height = this.image.style.height;
        //if any value is null, NaN, or undefined, don't save the position
        if (!left || !top || !width || !height) return;
        this.page._mapPositions = { left, top, width, height };
    }

    _loadPosition() {
        const position = this.page._mapPositions;
        if (!position) return;
        //if any value is null, NaN, or undefined, don't load the position
        if (!position.left || !position.top || !position.width || !position.height) return;
        this.image.style.left = position.left;
        this.image.style.top = position.top;
        this.image.style.width = position.width;
        this.image.style.height = position.height;
        return { imgX: parseFloat(position.left), imgY: parseFloat(position.top), width: parseFloat(position.width), height: parseFloat(position.height) };
    }

    _addMarker(event) {
        if (!this.page.isOwner || this._lockPins || this._rulerAnchor._enabled) return;
        const isLeftClick = event.button === 0;
        if (!isLeftClick) return;
        const isShiftDown = event.shiftKey;
        if (isShiftDown || this._movingMarker) return;
        const imageBoundingRect = this.image.getBoundingClientRect();
        const x = event.pageX - imageBoundingRect.left;
        const y = event.pageY - imageBoundingRect.top;
        const xPercent = x / imageBoundingRect.width;
        const yPercent = y / imageBoundingRect.height;
        this.mousePercent = { x: xPercent, y: yPercent };
        new MarkerConfig(this, this.page).render(true);
    }

    initMarkers() {
        //remove all markers
        this.image.querySelectorAll(".simple-quest-marker").forEach((marker) => {
            marker.remove();
        });
        const page = this.page;
        const markersFlag = getSimpleQuestFlag(page, "markers") ?? {};
        const markers = markersFlag;
        const globalLabelColor = getSetting("labelColor") !== "none" ? getSetting("labelColor") : null;
        if (!markers) return;

        for (const [id, markerData] of Object.entries(markers)) {
            if (markerData == null) continue;
            if (!page.isOwner && markerData.hidden) continue;
            const marker = document.createElement("div");
            marker.classList.add("simple-quest-marker");
            if (markerData.hidden) marker.style.border = "3px dashed";
            marker.style.position = "absolute";
            marker.style.left = markerData.x * 100 + "%";
            marker.style.top = markerData.y * 100 + "%";
            marker.style.color = markerData.color;
            marker.style.transform = markerData.fixedScale ? `translate(-50%, -50%) scale(calc(${markerData.scale ?? 1} * var(--zoom-level)))` : `translate(-50%, -50%) scale(${markerData.scale ?? 1})`;
            marker.style.display = "flex";
            marker.style.alignItems = "center";
            marker.style.justifyContent = "center";
            markerData.icon ??= "fas fa-location-dot";
            const ext = markerData.icon.split(".").pop().toLowerCase();
            const isVideo = ["mp4", "webm"].includes(ext);
            const isImage = !isVideo && markerData.icon.includes(".");
            const isFaIcon = markerData.icon.includes("fa-") && !isImage;
            const isText = !isImage && !isFaIcon && !isVideo;
            if (isVideo) marker.innerHTML = `<video class="marker-image" src="${markerData.icon}" autoplay loop muted></video>`;
            if (isText) marker.innerHTML = `<i class="emoji">${markerData.icon}</i>`;
            if (isImage) marker.innerHTML = `<i class="marker-image" style="background-image: url('${markerData.icon}')"></i>`;
            if (isFaIcon) marker.innerHTML = `<i class="${markerData.icon}"></i>`;
            marker.dataset.tooltipDirection = "UP";
            marker.dataset.tooltipClass = "simple-quest-marker-tooltip";
            if (markerData.displayLabel) {
                marker.dataset.tooltip = "";
            } else {
                marker.dataset.tooltip = `
                <h4 style="margin: 0">${markerData.title}</h4>
                `;
            }
            if (markerData.description) {
                marker.dataset.tooltip += `
                <p>${markerData.description}</p>
                `;
            }
            marker.style.cursor = markerData.journal ? "pointer" : "default";

            const markerLabel = document.createElement("span");
            markerLabel.innerText = markerData.title;
            markerLabel.style.position = "absolute";
            markerLabel.style.width = "max-content";
            markerLabel.style.bottom = "100%";
            markerLabel.style.fontSize = "calc(var(--simple-quest-font-size)*0.75)";
            markerLabel.style.pointerEvents = "none";
            if (globalLabelColor) markerLabel.style.color = globalLabelColor;

            if (markerData.displayLabel) marker.appendChild(markerLabel);

            if (page.isOwner && !this._lockPins) {
                let moveTime = 0;
                //add listener for right click down
                marker.addEventListener("mousedown", (e) => {
                    e.stopPropagation();
                    if (e.shiftKey) return;

                    const isRightClick = e.button === 2;
                    if (!isRightClick) return;
                    this._movingMarker = marker;
                    moveTime = Date.now();
                });
                //release and update the marker on mouse up
                marker.addEventListener("mouseup", (e) => {
                    e.stopPropagation();
                    if (e.shiftKey) return;
                    const isRightClick = e.button === 2;
                    if (e.altKey) {
                        //toggle hidden
                        const markersData = getSimpleQuestFlag(page, "markers") ?? {};
                        markersData[id].hidden = !markersData[id].hidden;
                        setSimpleQuestFlag(page, "markers", markersData);
                        return;
                    }
                    if (!isRightClick) return;
                    this._movingMarker = null;
                    const xPercent = parseFloat(marker.dataset.leftPercent);
                    const yPercent = parseFloat(marker.dataset.topPercent);
                    const diffX = Math.abs(xPercent - markerData.x);
                    const diffY = Math.abs(yPercent - markerData.y);
                    const deltaTime = Date.now() - moveTime;
                    if ((deltaTime < 500 && diffX < 0.0005 && diffY < 0.0005) || xPercent <= 0 || yPercent <= 0 || isNaN(xPercent) || isNaN(yPercent)) {
                        marker.style.left = markerData.x * 100 + "%";
                        marker.style.top = markerData.y * 100 + "%";
                        return new MarkerConfig(this, this.page, id).render(true);
                    }
                    const markers = getSimpleQuestFlag(page, "markers") ?? {};
                    markers[id].x = xPercent;
                    markers[id].y = yPercent;
                    setSimpleQuestFlag(page, "markers", markers);
                });
            }

            if (markerData.journal) {
                marker.addEventListener("click", async (e) => {
                    if (e.altKey) return;
                    e.preventDefault();
                    e.stopPropagation();
                    let uuid = markerData.journal;
                    const anchor = markerData.journal.split("#")[1];
                    if (anchor) uuid = markerData.journal.split("#")[0];
                    const journal = await fromUuid(uuid);

                    const isScene = journal instanceof Scene;
                    const isMacro = journal instanceof Macro;

                    if (isScene) {
                        ui.simpleQuest.toggle();
                        return journal.view();
                    }

                    if (isMacro) {
                        const macroArgs = { ...markerData, id, map: this.page };
                        return journal.execute(macroArgs);
                    }

                    //check if the journal is a quest first
                    const questJournals = ui.simpleQuest._questJournals;
                    const mapsJournal = this.page.parent;

                    let isQuest = false;

                    const isMap = Array.from(mapsJournal.pages).some((page) => page.uuid == journal.uuid);

                    for (const qJournal of questJournals) {
                        qJournal.pages.forEach((page) => {
                            if (page.uuid == journal.uuid) isQuest = true;
                        });
                    }

                    if (isQuest || isMap) {
                        ui.simpleQuest.openToPage(journal.uuid);
                    } else {
                        const isJournalPage = journal instanceof JournalEntryPage;
                        const hasPermission = journal.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
                        if (!hasPermission) return ui.notifications.error(game.i18n.localize(`${MODULE_ID}.noPermission`));
                        if (isJournalPage && getSetting("openJournalPinsAsModals")) this.openModalJournal(journal, markerData.journal);
                        else journal.sheet.render(true);
                    }
                });
            }

            this.image.appendChild(marker);
        }
    }

    async openModalJournal(journal, uuid) {
        const anchor = uuid.split("#")[1];
        const hasPermission = journal.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)
        if (!hasPermission) return ui.notifications.error(game.i18n.localize(`${MODULE_ID}.noPermission`));
        let content = "";
        if (journal.type === "text") {
            content = await foundry.applications.ux.TextEditor.implementation.enrichHTML(journal.text.content, { secrets: game.user.isGM, relativeTo: journal, async: true });
        } else if (journal.type === "image") {
            content = `<div class="simple-quest-image-journal" style="max-height: 50vh;"><img src="${journal.src}" alt="${journal.name}"><p>${journal.image.caption}</p></div>`;
        } else {
            content = `<p>This Page Type is not Supported in Simple Quest</p>`;
        }
        const modal = document.createElement("div");
        modal.classList.add("simple-quest-modal");
        modal.style.opacity = 0;
        const title = `<h1>${journal.name}</h1>`;
        modal.innerHTML = `<div class="simple-quest-modal-content">${title + content}</div>`;
        modal.addEventListener("mousedown", (e) => {
            //fade out and remove the modal
            modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in-out" }).onfinish = () => {
                modal.remove();
            };
        });
        modal.addEventListener("wheel", (e) => {
            e.stopPropagation();
        });
        modal.addEventListener("mousemove", (e) => {
            e.stopPropagation();
        });
        this.element.appendChild(modal);
        const height = this.element.getBoundingClientRect().height;
        const modalContentHeight = modal.querySelector(".simple-quest-modal-content").getBoundingClientRect().height;
        if (modalContentHeight < height) {
            modal.style.display = "flex";
            modal.style.justifyContent = "center";
            modal.style.flexDirection = "column";
        }
        //fade in
        modal.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-in-out", fill: "forwards" });
        //scroll to anchor
        if (anchor) {
            const toc = journal.toc[anchor];
            const tocText = toc.text.trim();
            //find h1 h2 or h3 with the same text
            const headers = modal.querySelectorAll("h1, h2, h3");
            let header;
            const sameNameHeaderIndex = anchor.includes("$") ? parseInt(anchor.split("$")[1]) : 0;
            const matchingHeaders = Array.from(headers).filter((h) => h.innerText.trim() === tocText);
            header = matchingHeaders[sameNameHeaderIndex];
            //scroll to anchor
            if (header) {
                header.scrollIntoView({ block: "start" });
            }
        }
    }

    loadMultiSource() {
        if (!this.isMultiSource) return false;

        //first check if the square root is an integer
        let squareRoot = Math.sqrt(this.multiSource.length);
        const isInteger = squareRoot % 1 === 0;

        const isMinusOneInteger = Math.sqrt(this.multiSource.length - 1) % 1 === 0 && !isInteger;

        if (!isInteger && !isMinusOneInteger) return false;

        this.multiImageElements = [];

        if (isMinusOneInteger) {
            squareRoot = Math.sqrt(this.multiSource.length - 1);
            this.multiSourceHasLowRes = true;
        }

        this.multiSourceSQRT = squareRoot;

        const gridSize = { x: squareRoot, y: squareRoot };

        this.image.style.display = "grid";
        this.image.style.gridTemplateColumns = `repeat(${gridSize.x}, 1fr)`;
        this.image.style.gridTemplateRows = `repeat(${gridSize.y}, 1fr)`;

        for (const src of this.multiSource) {
            if (isMinusOneInteger && this.multiSource.indexOf(src) == 0) continue;
            const image = document.createElement("div");
            if (isMinusOneInteger) image.style.display = "none";
            image.style.backgroundImage = `url('${src}')`;
            image.style.backgroundSize = "cover";
            image.style.backgroundPosition = "center";
            image.style.width = "100%";
            image.style.height = "100%";
            image.style.pointerEvents = "none";
            this.multiImageElements.push(image);
            this.image.appendChild(image);
        }
    }

    setMultiSourceVisibility(originalWidth, originalHeight, newWidth, newHeight) {
        if (!this.multiImageElements || !this.multiSourceHasLowRes) return;

        const zoomFactor = newWidth / originalWidth;
        const visible = zoomFactor > this.multiSourceSQRT;
        this.multiImageElements.forEach((image) => {
            image.style.display = visible ? "block" : "none";
        });
    }
}

class MarkerConfig extends FormApplication {
    constructor(mapImage, page, edit = null) {
        super();
        this.mapImage = mapImage;
        this.page = page;
        this.edit = edit;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "simple-quest-marker-config",
            template: `${SYSTEM_PATH}/templates/marker-config.hbs`,
            title: game.i18n.localize(`${MODULE_ID}.markerConfig.title`),
            classes: [],
            width: 400,
            height: "auto",
            resizable: false,
            closeOnSubmit: true,
        });
    }

    get defaultMarkerData() {
        return {
            title: "New Marker",
            icon: "fas fa-location-dot",
            color: "#ff0000",
            scale: 1,
        };
    }

    get markerIcons() {
        return [
            `${SYSTEM_PATH}/assets/icons/altar1.webp`,
            `${SYSTEM_PATH}/assets/icons/beer1.webp`,
            `${SYSTEM_PATH}/assets/icons/beer2.webp`,
            `${SYSTEM_PATH}/assets/icons/beer3.webp`,
            `${SYSTEM_PATH}/assets/icons/book1.webp`,
            `${SYSTEM_PATH}/assets/icons/book2.webp`,
            `${SYSTEM_PATH}/assets/icons/book3.webp`,
            `${SYSTEM_PATH}/assets/icons/book4.webp`,
            `${SYSTEM_PATH}/assets/icons/book5.webp`,
            `${SYSTEM_PATH}/assets/icons/boss1.webp`,
            `${SYSTEM_PATH}/assets/icons/boss2.webp`,
            `${SYSTEM_PATH}/assets/icons/boss3.webp`,
            `${SYSTEM_PATH}/assets/icons/boss4.webp`,
            `${SYSTEM_PATH}/assets/icons/coin1.webp`,
            `${SYSTEM_PATH}/assets/icons/coin2.webp`,
            `${SYSTEM_PATH}/assets/icons/coin3.webp`,
            `${SYSTEM_PATH}/assets/icons/coin4.webp`,
            `${SYSTEM_PATH}/assets/icons/combat1.webp`,
            `${SYSTEM_PATH}/assets/icons/combat2.webp`,
            `${SYSTEM_PATH}/assets/icons/combat3.webp`,
            `${SYSTEM_PATH}/assets/icons/doorway1.webp`,
            `${SYSTEM_PATH}/assets/icons/doorway2.webp`,
            `${SYSTEM_PATH}/assets/icons/doorway3.webp`,
            `${SYSTEM_PATH}/assets/icons/doorway4.webp`,
            `${SYSTEM_PATH}/assets/icons/doorway5.webp`,
            `${SYSTEM_PATH}/assets/icons/exclamation1.webp`,
            `${SYSTEM_PATH}/assets/icons/exclamation2.webp`,
            `${SYSTEM_PATH}/assets/icons/exclamation3.webp`,
            `${SYSTEM_PATH}/assets/icons/exclamation4.webp`,
            `${SYSTEM_PATH}/assets/icons/food1.webp`,
            `${SYSTEM_PATH}/assets/icons/food2.webp`,
            `${SYSTEM_PATH}/assets/icons/food3.webp`,
            `${SYSTEM_PATH}/assets/icons/key1.webp`,
            `${SYSTEM_PATH}/assets/icons/key2.webp`,
            `${SYSTEM_PATH}/assets/icons/location1.webp`,
            `${SYSTEM_PATH}/assets/icons/location10.webp`,
            `${SYSTEM_PATH}/assets/icons/location2.webp`,
            `${SYSTEM_PATH}/assets/icons/location3.webp`,
            `${SYSTEM_PATH}/assets/icons/location4.webp`,
            `${SYSTEM_PATH}/assets/icons/location5.webp`,
            `${SYSTEM_PATH}/assets/icons/location6.webp`,
            `${SYSTEM_PATH}/assets/icons/location7.webp`,
            `${SYSTEM_PATH}/assets/icons/location8.webp`,
            `${SYSTEM_PATH}/assets/icons/location9.webp`,
            `${SYSTEM_PATH}/assets/icons/map1.webp`,
            `${SYSTEM_PATH}/assets/icons/map2.webp`,
            `${SYSTEM_PATH}/assets/icons/map3.webp`,
            `${SYSTEM_PATH}/assets/icons/monster1.webp`,
            `${SYSTEM_PATH}/assets/icons/monster2.webp`,
            `${SYSTEM_PATH}/assets/icons/monster3.webp`,
            `${SYSTEM_PATH}/assets/icons/monster4.webp`,
            `${SYSTEM_PATH}/assets/icons/note1.webp`,
            `${SYSTEM_PATH}/assets/icons/note2.webp`,
            `${SYSTEM_PATH}/assets/icons/note3.webp`,
            `${SYSTEM_PATH}/assets/icons/note4.webp`,
            `${SYSTEM_PATH}/assets/icons/ore1.webp`,
            `${SYSTEM_PATH}/assets/icons/ore2.webp`,
            `${SYSTEM_PATH}/assets/icons/ore3.webp`,
            `${SYSTEM_PATH}/assets/icons/ore4.webp`,
            `${SYSTEM_PATH}/assets/icons/ore5.webp`,
            `${SYSTEM_PATH}/assets/icons/ore6.webp`,
            `${SYSTEM_PATH}/assets/icons/ore7.webp`,
            `${SYSTEM_PATH}/assets/icons/painting1.webp`,
            `${SYSTEM_PATH}/assets/icons/painting2.webp`,
            `${SYSTEM_PATH}/assets/icons/painting3.webp`,
            `${SYSTEM_PATH}/assets/icons/pendant1.webp`,
            `${SYSTEM_PATH}/assets/icons/pendant2.webp`,
            `${SYSTEM_PATH}/assets/icons/pendant3.webp`,
            `${SYSTEM_PATH}/assets/icons/plant1.webp`,
            `${SYSTEM_PATH}/assets/icons/plant2.webp`,
            `${SYSTEM_PATH}/assets/icons/plant3.webp`,
            `${SYSTEM_PATH}/assets/icons/plant4.webp`,
            `${SYSTEM_PATH}/assets/icons/plant5.webp`,
            `${SYSTEM_PATH}/assets/icons/plant6.webp`,
            `${SYSTEM_PATH}/assets/icons/plant7.webp`,
            `${SYSTEM_PATH}/assets/icons/plant8.webp`,
            `${SYSTEM_PATH}/assets/icons/portal1.webp`,
            `${SYSTEM_PATH}/assets/icons/portal2.webp`,
            `${SYSTEM_PATH}/assets/icons/portal3.webp`,
            `${SYSTEM_PATH}/assets/icons/portal4.webp`,
            `${SYSTEM_PATH}/assets/icons/pouch1.webp`,
            `${SYSTEM_PATH}/assets/icons/pouch2.webp`,
            `${SYSTEM_PATH}/assets/icons/pouch3.webp`,
            `${SYSTEM_PATH}/assets/icons/pouch4.webp`,
            `${SYSTEM_PATH}/assets/icons/question1.webp`,
            `${SYSTEM_PATH}/assets/icons/question2.webp`,
            `${SYSTEM_PATH}/assets/icons/question3.webp`,
            `${SYSTEM_PATH}/assets/icons/question4.webp`,
            `${SYSTEM_PATH}/assets/icons/scroll1.webp`,
            `${SYSTEM_PATH}/assets/icons/scroll2.webp`,
            `${SYSTEM_PATH}/assets/icons/scroll3.webp`,
            `${SYSTEM_PATH}/assets/icons/shield1.webp`,
            `${SYSTEM_PATH}/assets/icons/shield2.webp`,
            `${SYSTEM_PATH}/assets/icons/shield3.webp`,
            `${SYSTEM_PATH}/assets/icons/shield4.webp`,
            `${SYSTEM_PATH}/assets/icons/skull1.webp`,
            `${SYSTEM_PATH}/assets/icons/skull2.webp`,
            `${SYSTEM_PATH}/assets/icons/skull3.webp`,
            `${SYSTEM_PATH}/assets/icons/spell1.webp`,
            `${SYSTEM_PATH}/assets/icons/spell2.webp`,
            `${SYSTEM_PATH}/assets/icons/spell3.webp`,
            `${SYSTEM_PATH}/assets/icons/spell4.webp`,
            `${SYSTEM_PATH}/assets/icons/spell5.webp`,
            `${SYSTEM_PATH}/assets/icons/spell6.webp`,
            `${SYSTEM_PATH}/assets/icons/spell7.webp`,
            `${SYSTEM_PATH}/assets/icons/spell8.webp`,
            `${SYSTEM_PATH}/assets/icons/tree1.webp`,
            `${SYSTEM_PATH}/assets/icons/tree2.webp`,
            `${SYSTEM_PATH}/assets/icons/tree3.webp`,
            `${SYSTEM_PATH}/assets/icons/tree4.webp`,
            "fas fa-location-dot",
            "fa-solid fa-exclamation",
            "fa-solid fa-question",
            "fas fa-dragon",
            "fas fa-sword",
            "fas fa-shield-alt",
            "fas fa-helmet-battle",
            "fas fa-axe",
            "fas fa-scroll",
            "fas fa-scroll-old",
            "fas fa-treasure-chest",
            "fas fa-magic",
            "fas fa-crystal-ball",
            "fas fa-book-dead",
            "fas fa-bone",
            "fas fa-flask-round-potion",
            "fas fa-flask-round-poison",
            "fas fa-ring",
            "fas fa-crown",
            "fas fa-dice",
            "fas fa-hourglass-end",
            "fas fa-bow-arrow",
            "fas fa-meteor",
            "fas fa-moon",
            "fas fa-sun",
            "fas fa-cloud-moon",
            "fas fa-cloud-sun",
            "fas fa-coin",
            "fas fa-skull-crossbones",
            "fas fa-dungeon",
            "fas fa-mountain",
            "fas fa-tree",
            "fas fa-campfire",
            "fas fa-compass",
            "fa-solid fa-bullseye",
            "fas fa-feather-alt",
            "fas fa-bug",
            "fas fa-paw",
            "fas fa-fish",
            "fas fa-bird",
            "fas fa-horse",
            "fas fa-spider",
            "fas fa-ghost",
            "fas fa-bat",
            "fas fa-wand-magic",
            "fas fa-hat-wizard",
            "fas fa-staff",
            "fas fa-flag-checkered",
            "fas fa-map",
            "fas fa-anchor",
            "fas fa-ship",
            "fas fa-skull",
            "fas fa-cross",
            "fas fa-ban",
            "fas fa-gem",
            "fas fa-leaf",
            "fas fa-flower",
            "fas fa-mushroom",
            "fas fa-paw-claws",
            "fas fa-star",
            "fas fa-fire",
            "fa-solid fa-fire-flame-curved",
            "fas fa-water",
            "fas fa-wind",
            "fas fa-earth",
            "fas fa-heart",
            "fas fa-mind-share",
            "fas fa-sword-laser",
            "fas fa-moon-stars",
            "fas fa-cloud",
            "fas fa-rainbow",
            "fas fa-axe-battle",
            "fas fa-brain",
            "fas fa-crow",
            "fas fa-dagger",
            "fas fa-frog",
            "fas fa-globe",
            "fas fa-hammer",
            "fas fa-hat-witch",
            "fas fa-pumpkin",
            "fas fa-candle-holder",
            "fas fa-broom",
            "fas fa-dice-d20",
            "fas fa-tornado",
            "fas fa-cloud-showers-heavy",
        ];
    }

    activateListeners(html) {
        super.activateListeners(html);
        html[0].querySelector("#delete-marker").addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.page.update({ [`${FLAG_PATH}.markers.-=${this.edit}`]: null });
            this.close();
        });

        html[0].querySelectorAll(".quest-icons i").forEach((icon) => {
            icon.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const iconInput = html[0].querySelector("#icon");
                iconInput.value = icon.classList.value;
            });
        });

        html[0].querySelector("#journal").addEventListener("drop", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
                const dragData = JSON.parse(e.dataTransfer.getData("text/plain"));
                const uuid = dragData.uuid;
                const journal = await fromUuid(uuid);
                const title = journal.name ?? journal.title;
                const titleInput = html[0].querySelector("#title");
                if (!titleInput.value || titleInput.value == "New Marker") titleInput.value = title;
                html[0].querySelector("#journal").value = uuid;
                if (dragData.anchor) {
                    titleInput.value = dragData.anchor.name;
                    html[0].querySelector("#journal").value += "#" + dragData.anchor.slug;
                }
            } catch (e) {}
        });
    }

    getData() {
        const markersFlag = getSimpleQuestFlag(this.page, "markers") ?? {};
        const markers = markersFlag ?? {};
        const markerData = markers[this.edit] ?? {};

        return {
            ...foundry.utils.mergeObject(this.defaultMarkerData, markerData),
            id: this.edit,
            icons: this.markerIcons.map((icon) => {
                return {
                    icon,
                    isImage: icon.includes("."),
                };
            }),
        };
    }

    async _updateObject(event, formData) {
        event.preventDefault();
        formData = foundry.utils.expandObject(formData);
        if (!this.edit) {
            formData.x = this.mapImage.mousePercent.x;
            formData.y = this.mapImage.mousePercent.y;
        }
        const markers = getSimpleQuestFlag(this.page, "markers") ?? {};
        markers[this.edit ?? foundry.utils.randomID(20)] = formData;
        await setSimpleQuestFlag(this.page, "markers", markers);
    }
}
